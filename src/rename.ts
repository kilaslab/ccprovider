import { lstatSync, readdirSync, readFileSync, renameSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { profileDir, type Paths } from './paths.js'
import { getProfile, ProfileError, saveStore, validateName } from './profile.js'
import type { SecretStore } from './secrets/index.js'
import { shellQuote } from './shell.js'
import { commandName, inspectShim, installShim, removeShim } from './shim.js'
import type { Profile, ProfileStore } from './types.js'

export interface RenameDeps {
  paths: Paths
  secrets: SecretStore
  store: ProfileStore
  /** What a launcher for the new name should exec — see `selfLauncher`. */
  launcher: string[]
  /** Injectable so a test can make the commit point itself fail. */
  save?: (paths: Paths, store: ProfileStore) => void
}

export interface RenameResult {
  /** Whether a launcher command was moved along with the profile. */
  command: 'moved' | 'none'
  /** Things that went wrong after the rename was already committed. Never fatal. */
  warnings: string[]
  /** Python virtualenvs inside the profile that still point at the old directory. */
  staleVenvs: string[]
}

/**
 * Rename a profile, keeping its four identities in step: the store key, the profile
 * directory (which holds the session history), the secret-store account, and the
 * launcher command.
 *
 * Every change before the store is saved has an undo, and the store write is the commit
 * point: fail anywhere before it and the previous state is restored; fail after it and
 * the rename stands, with the leftover cleanup reported as warnings. Nothing is left
 * half-renamed with the config still naming the old profile.
 */
export async function renameProfile(deps: RenameDeps, fromRaw: string, toRaw: string): Promise<RenameResult> {
  const { paths, secrets, store, launcher } = deps
  const save = deps.save ?? saveStore

  // ---- preflight: nothing below this block may change anything
  const from = validateName(fromRaw)
  const to = validateName(toRaw)
  const profile = getProfile(store, from)
  if (from === to) throw new ProfileError(`"${from}" is already called that.`)
  if (to in store.providers) throw new ProfileError(`A profile named "${to}" already exists.`)

  const dirFrom = profileDir(paths, from)
  const dirTo = profileDir(paths, to)
  // lstat, not exists: a dangling symlink at the target still occupies the name.
  if (lstatSafe(dirTo)) {
    // The two causes need opposite advice, and only one is safe to guess. If `from` has
    // no directory either, an interrupted earlier rename is the likely story: the history
    // is in `dirTo`, and "moving it aside" would strand it.
    throw new ProfileError(
      lstatSafe(dirFrom)
        ? `${dirTo} already exists (left over from a deleted profile?). Move it aside first.`
        : `${dirTo} already exists, and "${from}" has no directory of its own. If an earlier rename was interrupted, ` +
            `the session history is in ${dirTo}: put it back with \`mv ${shellQuote(dirTo)} ${shellQuote(dirFrom)}\` and run the rename again. ` +
            `Otherwise it is left over from a deleted profile — move it aside first.`,
    )
  }

  // A read failure here must abort *before* anything moves: a rename that cannot read
  // the key would strand it under the old name.
  const key = await secrets.get(from)
  const existingTo = await secrets.get(to)
  // The same key already under the new name is what an interrupted earlier attempt leaves
  // behind, and setting it again changes nothing. A *different* one is somebody's, and
  // is never overwritten.
  if (existingTo !== null && existingTo !== key) {
    throw new ProfileError(
      `The secret store already holds a different key under "${to}", so it was not overwritten. If it is left over from ` +
        `a deleted profile, remove it with your secret store's own tools (service "ccprovider", account "${to}"; ` +
        `on macOS: \`security delete-generic-password -s ccprovider -a ${to}\`), then run the rename again.`,
    )
  }

  const hadCommand = inspectShim(paths, from).state === 'ours'
  if (hadCommand) {
    commandName(to) // reserved names fail here, not halfway through
    if (inspectShim(paths, to).state === 'foreign') {
      throw new ProfileError(
        `${join(paths.binDir, to)} is not one of ccprovider's launchers, so "${to}" cannot become a command. Pick another name.`,
      )
    }
  }

  // ---- mutate, with an undo for each step
  const undo: Array<() => void | Promise<void>> = []
  try {
    if (key !== null) {
      await secrets.set(to, key)
      undo.push(() => secrets.delete(to))
    }
    if (lstatSafe(dirFrom)) {
      renameSync(dirFrom, dirTo)
      undo.push(() => renameSync(dirTo, dirFrom))
    }
    if (hadCommand) {
      installShim(paths, to, launcher)
      undo.push(() => void removeShim(paths, to))
    }

    // Rebuilt rather than delete+add so the profile keeps its place in the list.
    const providers: Record<string, Profile> = {}
    for (const [name, p] of Object.entries(store.providers)) providers[name === from ? to : name] = p
    save(paths, { version: 1, providers }) // <- commit point
    store.providers = providers
  } catch (e) {
    const stuck: string[] = []
    for (const step of undo.reverse()) {
      try {
        await step()
      } catch (u) {
        stuck.push((u as Error).message)
      }
    }
    throw new ProfileError(
      `Could not rename "${from}" to "${to}": ${(e as Error).message}. ` +
        (stuck.length ? `Undoing it also failed (${stuck.join('; ')}); check ${dirFrom} and ${dirTo}.` : 'Nothing was changed.'),
      { cause: e },
    )
  }

  // ---- committed: leftovers are warnings, not failures
  const warnings: string[] = []
  if (hadCommand) {
    try {
      removeShim(paths, from)
    } catch (e) {
      warnings.push(`Could not remove the old \`${from}\` command: ${(e as Error).message}`)
    }
  }
  if (key !== null) {
    try {
      await secrets.delete(from)
    } catch (e) {
      warnings.push(`The old key entry "${from}" is still in the secret store (${(e as Error).message}); it is unused and safe to delete.`)
    }
  }

  return { command: hadCommand ? 'moved' : 'none', warnings, staleVenvs: staleVirtualenvs(dirTo, dirFrom) }
}

/** Directories not worth descending into: session data is large and holds no venvs, and
 *  symlinks (the shared skills/plugins) point outside the profile entirely. */
const SKIP = new Set(['projects', 'session-env', 'node_modules', '.git'])

/**
 * Virtualenvs that still name `oldDir`.
 *
 * Claude Code tooling sometimes builds a Python venv inside the config directory (seen
 * in real profiles: `security/agent-sdk-venv`). Its scripts carry absolute shebangs, so
 * moving the directory breaks it. It is regenerable, so the right response is to say
 * which one, not to rewrite files that belong to another tool.
 */
export function staleVirtualenvs(root: string, oldDir: string, depth = 4): string[] {
  const found: string[] = []
  const walk = (dir: string, left: number) => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue
      if (e.isFile() && e.name === 'pyvenv.cfg') {
        try {
          if (readFileSync(join(dir, e.name), 'utf8').includes(oldDir)) found.push(dir)
        } catch {
          // unreadable: not worth reporting
        }
      } else if (e.isDirectory() && left > 0 && !SKIP.has(e.name)) {
        walk(join(dir, e.name), left - 1)
      }
    }
  }
  walk(root, depth)
  return found
}

function lstatSafe(p: string) {
  try {
    return lstatSync(p)
  } catch {
    return null
  }
}

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Paths } from './paths.js'
import { ProfileError, validateProfile } from './profile.js'
import { isClaude, isOauth, type Profile } from './types.js'

/** The fixed name `add --default` writes: one profile, overwritten in place, that the plain
 *  `claude` runs. */
export const DEFAULT_SLOT = 'default'

/** One stretch of the slot's life: from `from` (epoch seconds) it was this provider. Lets
 *  `usage` say which provider a call went to, from the time of the call instead of a guess
 *  from the model's name. */
export interface Epoch {
  from: number
  /** `presetKey` of the provider the slot was then. */
  preset: string
  /** Whether it was a Claude subscription then (billed by a plan, not by tokens). */
  claude: boolean
}

/**
 * What the slot remembers beside `providers.json`.
 *
 * - `variants`: the configurations the slot had before, one per provider, so
 *   `default --use <provider>` can swap one back without a wizard. A variant's secret is kept in
 *   the secret store under `default:<key>`; this file is the only index of them, because no
 *   backend can list its accounts.
 * - `epochs`: when the slot changed provider, oldest first.
 *
 * A file of its own and not a key in `providers.json`: that file is rebuilt field by field on
 * every save (and by older versions), which would silently drop anything unknown and orphan the
 * secrets it pointed at.
 */
export interface SlotFile {
  version: 1
  variants: Record<string, Profile>
  epochs: Epoch[]
}

const KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

export const emptySlot = (): SlotFile => ({ version: 1, variants: {}, epochs: [] })

export function slotFilePath(paths: Paths): string {
  return join(dirname(paths.configFile), 'slot.json')
}

/** What a variant is filed under: the provider, not the profile's name. A hand-written profile
 *  with no preset is `custom`, and a second such one replaces the first. */
export function presetKey(profile: Profile): string {
  const key = isOauth(profile) ? 'claude' : (profile.preset ?? 'custom')
  return KEY_RE.test(key) ? key : 'custom'
}

/** The secret-store account of a stashed variant. A `:` cannot be in a profile name, so it
 *  cannot be any profile's own account. */
export function variantAccount(key: string): string {
  return `${DEFAULT_SLOT}:${key}`
}

export function describeEpoch(profile: Profile, from: number): Epoch {
  return { from, preset: presetKey(profile), claude: isClaude(profile) }
}

export function loadSlot(paths: Paths): SlotFile {
  const file = slotFilePath(paths)
  if (!existsSync(file)) return emptySlot()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new ProfileError(`${file} is not valid JSON: ${(e as Error).message}`)
  }
  return validateSlot(raw, file)
}

export function saveSlot(paths: Paths, slot: SlotFile): void {
  const file = slotFilePath(paths)
  mkdirSync(dirname(file), { recursive: true })
  // Write-then-rename, like the profile config: a crash must not leave a truncated file that
  // would read as an error on every later run.
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(slot, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

export function removeSlot(paths: Paths): void {
  rmSync(slotFilePath(paths), { force: true })
}

export function validateSlot(raw: unknown, source = 'slot'): SlotFile {
  if (typeof raw !== 'object' || raw === null) throw new ProfileError(`${source}: expected an object`)
  const obj = raw as Record<string, unknown>
  if (obj.version !== 1) throw new ProfileError(`${source}: unsupported version ${String(obj.version)} (expected 1)`)

  const variants: Record<string, Profile> = {}
  if (obj.variants !== undefined) {
    if (typeof obj.variants !== 'object' || obj.variants === null || Array.isArray(obj.variants)) {
      throw new ProfileError(`${source}: "variants" must be an object`)
    }
    for (const [key, value] of Object.entries(obj.variants as Record<string, unknown>)) {
      if (!KEY_RE.test(key)) throw new ProfileError(`${source}: "${key}" is not a valid variant name (lowercase letters, digits, dash)`)
      variants[key] = validateProfile(value, `${source}: variant "${key}"`)
    }
  }

  const epochs: Epoch[] = []
  if (obj.epochs !== undefined) {
    if (!Array.isArray(obj.epochs)) throw new ProfileError(`${source}: "epochs" must be an array`)
    for (const e of obj.epochs as unknown[]) {
      const x = e as Record<string, unknown> | null
      if (!x || typeof x.from !== 'number' || !Number.isFinite(x.from) || x.from < 0 || typeof x.preset !== 'string' || typeof x.claude !== 'boolean') {
        throw new ProfileError(`${source}: every epoch needs a non-negative "from", a "preset" and a "claude" flag`)
      }
      epochs.push({ from: x.from, preset: x.preset, claude: x.claude })
    }
    epochs.sort((a, b) => a.from - b.from)
  }
  return { version: 1, variants, epochs }
}

/** Has the profile called `default` ever been run as the slot? An ordinary profile that happens
 *  to have the name has no file, and keeps every ordinary right (rename, rm). */
export function slotInUse(paths: Paths): boolean {
  if (!existsSync(slotFilePath(paths))) return false
  const slot = loadSlot(paths)
  return Object.keys(slot.variants).length > 0 || slot.epochs.length > 0
}

/** The epoch in force at `ts`: the latest one that began at or before it. */
export function epochAt(epochs: Epoch[], ts: number): Epoch | undefined {
  let found: Epoch | undefined
  for (const e of epochs) {
    if (e.from <= ts) found = e
    else break
  }
  return found
}

// ---- the /login credential of a stashed Claude subscription

const LOGIN = '.credentials.json'
const STASHED_LOGIN = '.credentials.stashed.json'

/** Put a `/login` credential aside when the slot stops being that subscription, instead of
 *  deleting it, so swapping back does not need a fresh login. Returns a warning, or null. */
export function stashLogin(dir: string): string | null {
  try {
    const file = join(dir, LOGIN)
    if (existsSync(file)) renameSync(file, join(dir, STASHED_LOGIN))
    return null
  } catch (e) {
    return `Could not set the old /login aside at ${join(dir, LOGIN)} (${(e as Error).message}); the next /login in this profile will replace it.`
  }
}

/** The other way: bring a stashed `/login` back, unless a newer one is already in place. */
export function restoreLogin(dir: string): string | null {
  try {
    const stashed = join(dir, STASHED_LOGIN)
    if (existsSync(stashed) && !existsSync(join(dir, LOGIN))) renameSync(stashed, join(dir, LOGIN))
    return null
  } catch (e) {
    return `Could not bring the old /login back from ${join(dir, STASHED_LOGIN)} (${(e as Error).message}); sign in again with /login.`
  }
}

import { rmSync } from 'node:fs'
import type { ClaudeLogins } from './claudelogin.js'
import { removeProfileDir } from './configdir.js'
import { profileDir, type Paths } from './paths.js'
import { DEFAULT_SLOT, dropSlotFile } from './defaultslot.js'
import { getProfile, saveStore } from './profile.js'
import type { SecretStore } from './secrets/index.js'
import { removeDefaultShim, removeShim } from './shim.js'
import { ledgerFiles } from './usage.js'
import type { ProfileStore } from './types.js'

export interface RemoveDeps {
  paths: Paths
  secrets: SecretStore
  logins: ClaudeLogins
  store: ProfileStore
}

export interface RemoveResult {
  /** What happened to a launcher of the same name: only one ccprovider wrote is removed. */
  command: 'removed' | 'absent' | 'foreign' | 'failed'
  /** Set when the plain `claude` command ran this profile and went with it. */
  defaultCommand?: 'removed'
  /** Leftovers after the profile itself is gone. Never fatal. */
  warnings: string[]
}

/**
 * Delete a profile: its directory (session history and its own agents), its key, its Claude
 * login, its entry in the config, and its command. Used by `rm`, and by `add` when the user
 * chooses to replace a profile of the same name.
 *
 * The directory goes first and the config write is what makes it final, so a failure
 * after that — a denied Keychain prompt — is reported rather than leaving a profile in
 * the config with no directory.
 */
export async function removeProfile(deps: RemoveDeps, name: string, opts: { keepDefault?: boolean } = {}): Promise<RemoveResult> {
  const { paths, secrets, logins, store } = deps
  getProfile(store, name)
  const warnings: string[] = []

  const dir = profileDir(paths, name)
  removeProfileDir(dir, paths.dirsRoot)
  try {
    await secrets.delete(name)
  } catch (e) {
    warnings.push(`The key for "${name}" is still in the secret store (${(e as Error).message}); it is unused and safe to delete.`)
  }
  // Any profile's, not only a subscription's: whatever signed in with /login in this directory.
  // On macOS it is in the Keychain under the directory's path, out of reach of removing the
  // directory, and a profile added later under this name would come up signed in as it.
  try {
    await logins.delete(dir)
  } catch (e) {
    warnings.push(`The Claude login for "${name}" is still in the ${logins.name} (${(e as Error).message}); it is unused and safe to delete.`)
  }
  delete store.providers[name]
  saveStore(paths, store)
  // The default's stashed providers go with it: their keys would otherwise sit in the secret
  // store with nothing left to say what they are.
  if (name === DEFAULT_SLOT) warnings.push(...(await dropSlotFile({ paths, secrets })))

  // `kimi` or `claude` in the same directory belong to someone else even if a profile
  // once shared the name.
  let command: RemoveResult['command']
  try {
    command = removeShim(paths, name)
  } catch (e) {
    command = 'failed'
    warnings.push(`Could not remove the \`${name}\` command: ${(e as Error).message}`)
  }

  // Its record of use goes with it: kept, it would be added to a later profile of this name.
  try {
    for (const file of ledgerFiles(paths, name)) rmSync(file, { force: true })
  } catch (e) {
    warnings.push(`Could not remove the usage record for "${name}": ${(e as Error).message}`)
  }

  // `claude` would otherwise keep launching a profile that no longer exists.
  let defaultCommand: RemoveResult['defaultCommand']
  try {
    // Not when `add` is replacing the profile: one of the same name is created straight away,
    // and `claude` would otherwise fall back to stock Claude Code without a word.
    if (!opts.keepDefault && removeDefaultShim(paths, name) === 'removed') defaultCommand = 'removed'
  } catch (e) {
    warnings.push(`Could not remove the default \`claude\` command: ${(e as Error).message}`)
  }
  return { command, ...(defaultCommand ? { defaultCommand } : {}), warnings }
}

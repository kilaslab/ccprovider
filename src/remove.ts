import { rmSync } from 'node:fs'
import { removeProfileDir } from './configdir.js'
import { profileDir, type Paths } from './paths.js'
import { getProfile, saveStore } from './profile.js'
import type { SecretStore } from './secrets/index.js'
import { removeDefaultShim, removeShim } from './shim.js'
import { ledgerFiles } from './usage.js'
import type { ProfileStore } from './types.js'

export interface RemoveDeps {
  paths: Paths
  secrets: SecretStore
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
 * Delete a profile: its directory (session history and its own agents), its key, its
 * entry in the config, and its command. Used by `rm`, and by `add` when the user chooses
 * to replace a profile of the same name.
 *
 * The directory goes first and the config write is what makes it final, so a failure
 * after that — a denied Keychain prompt — is reported rather than leaving a profile in
 * the config with no directory.
 */
export async function removeProfile(deps: RemoveDeps, name: string, opts: { keepDefault?: boolean } = {}): Promise<RemoveResult> {
  const { paths, secrets, store } = deps
  getProfile(store, name)
  const warnings: string[] = []

  removeProfileDir(profileDir(paths, name), paths.dirsRoot)
  try {
    await secrets.delete(name)
  } catch (e) {
    warnings.push(`The key for "${name}" is still in the secret store (${(e as Error).message}); it is unused and safe to delete.`)
  }
  delete store.providers[name]
  saveStore(paths, store)

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

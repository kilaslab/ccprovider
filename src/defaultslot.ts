import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from './paths.js'
import { profileDir } from './paths.js'
import { ProfileError, loadStore, saveStore } from './profile.js'
import type { SecretStore } from './secrets/index.js'
import { inspectDefaultShim, installDefaultShim } from './shim.js'
import { isOauth, type Profile } from './types.js'

/** The fixed name `add --default` writes. One slot, overwritten in place, so choosing a new
 *  default never adds a profile. */
export const DEFAULT_SLOT = 'default'

export interface SlotResult {
  /** What the slot held before, or null when it was empty. */
  previous: Profile | null
  warnings: string[]
  /** Things that stay as they were and might not be expected. Not a failure. */
  notes: string[]
  shim: ReturnType<typeof installDefaultShim>
}

/** Refuse before anything is written when `claude` in the wrapper directory is not ours:
 *  the wrapper is the last step, and by then the old default would already be gone. */
export function assertSlotWritable(paths: Paths): void {
  const wrapper = inspectDefaultShim(paths)
  if (wrapper.state === 'foreign') {
    throw new ProfileError(`${wrapper.path} exists and was not created by ccprovider, so it cannot become the default \`claude\`. Move it aside and run \`ccprovider add --default\` again.`)
  }
}

/**
 * Put `profile` in the `default` slot and make the plain `claude` run it.
 *
 * The slot's directory is kept: its session history survives a change of provider, and
 * `edit` has always kept it too. What is swapped is the profile entry, the secret, and the
 * leftovers of the old one that would otherwise linger (a `/login` credential file).
 *
 * The secret goes first and the profile entry second, each undone if the next step fails:
 * a half-done swap would pair the new provider with the old one's key, and send a third
 * party's key to Anthropic or an Anthropic token to a third party.
 *
 * `apiKey` is the key or setup-token, or null for a `/login` profile, which stores none.
 */
export async function saveDefaultSlot(
  deps: { paths: Paths; secrets: SecretStore },
  profile: Profile,
  apiKey: string | null,
  launcher: string[],
): Promise<SlotResult> {
  const { paths, secrets } = deps
  assertSlotWritable(paths)
  const warnings: string[] = []
  const notes: string[] = []
  const store = loadStore(paths)
  const previous = Object.hasOwn(store.providers, DEFAULT_SLOT) ? store.providers[DEFAULT_SLOT]! : null

  const oldSecret = await secrets.get(DEFAULT_SLOT)
  // Whether the secret store now differs from before, so a failed write below can undo it.
  let swapped = false
  if (apiKey) {
    await secrets.set(DEFAULT_SLOT, apiKey)
    swapped = true
  } else if (oldSecret !== null) {
    try {
      await secrets.delete(DEFAULT_SLOT)
      swapped = true
    } catch (e) {
      warnings.push(`The old key for "${DEFAULT_SLOT}" is still in the secret store (${(e as Error).message}); it is unused and safe to delete.`)
    }
  }

  try {
    store.providers[DEFAULT_SLOT] = profile
    saveStore(paths, store)
  } catch (e) {
    if (swapped) await (oldSecret !== null ? secrets.set(DEFAULT_SLOT, oldSecret) : secrets.delete(DEFAULT_SLOT)).catch(() => {})
    throw e
  }

  if (previous && isOauth(previous) && !isOauth(profile)) {
    const credentials = join(profileDir(paths, DEFAULT_SLOT), '.credentials.json')
    // The swap is already done, so a file that cannot be removed is reported and not thrown:
    // the wrapper and the profile's own config still have to be finished.
    try {
      if (existsSync(credentials)) unlinkSync(credentials)
    } catch (e) {
      warnings.push(`Could not remove the old /login at ${credentials} (${(e as Error).message}); it is unused now.`)
    }
    // macOS keeps the login in the Keychain, keyed to the directory, where this cannot reach it.
    if (process.platform === 'darwin') {
      warnings.push('The previous /login for the default may remain in the macOS Keychain; it is unused now. Sign out with /logout in a session of the old profile to clear it.')
    }
  } else if (previous && isOauth(previous) && isOauth(profile)) {
    notes.push('The default is still signed in as before: /login keeps the account it had. Use /logout and /login inside Claude Code to switch accounts.')
  }

  return { previous, warnings, notes, shim: installDefaultShim(paths, DEFAULT_SLOT, launcher) }
}

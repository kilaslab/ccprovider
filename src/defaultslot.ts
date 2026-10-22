import type { Paths } from './paths.js'
import { profileDir } from './paths.js'
import { ProfileError, loadStore, saveStore } from './profile.js'
import type { SecretStore } from './secrets/index.js'
import { inspectDefaultShim, installDefaultShim } from './shim.js'
import {
  DEFAULT_SLOT, describeEpoch, loadSlot, presetKey, removeSlot, restoreLogin, saveSlot, slotFilePath, stashLogin, variantAccount,
} from './slot.js'
import { isOauth, type Profile } from './types.js'
import { existsSync } from 'node:fs'

export { DEFAULT_SLOT }

export interface SlotDeps {
  paths: Paths
  secrets: SecretStore
  /** Epoch seconds. Injectable so tests can place a switch in time. */
  now?: () => number
}

export interface SlotResult {
  /** What the slot held before, or null when it was empty. */
  previous: Profile | null
  /** The provider the previous configuration was kept under, if it was kept. */
  stashed: string | null
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
 * The slot's directory is kept, so its session history survives a change of provider. What is
 * swapped is the profile entry and the secret; what the slot was is not thrown away but kept as
 * a variant (see `SlotFile`), so `default --use <provider>` can bring it back with no wizard and
 * no key typed again. A `/login` credential is set aside for the same reason, not deleted.
 *
 * Every step is undone if a later one fails: a half-done swap would pair the new provider with
 * the old one's key, and send a third party's key to Anthropic or an Anthropic token to a third
 * party. The secrets go first, the profile entry second, the slot file last.
 *
 * `apiKey` is the key or setup-token, or null for a `/login` profile, which stores none.
 */
export async function saveDefaultSlot(
  deps: SlotDeps,
  profile: Profile,
  apiKey: string | null,
  launcher: string[],
): Promise<SlotResult> {
  const { paths, secrets } = deps
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000))
  assertSlotWritable(paths)

  const warnings: string[] = []
  const notes: string[] = []
  const store = loadStore(paths)
  const storeBefore = structuredClone(store)
  const slotBefore = loadSlot(paths)
  const slotExisted = existsSync(slotFilePath(paths))
  const previous = Object.hasOwn(store.providers, DEFAULT_SLOT) ? store.providers[DEFAULT_SLOT]! : null
  const newKey = presetKey(profile)
  const prevKey = previous ? presetKey(previous) : null
  const oldSecret = await secrets.get(DEFAULT_SLOT)

  const undo: Array<() => Promise<void>> = []
  const setSecret = async (account: string, value: string) => {
    const before = await secrets.get(account)
    await secrets.set(account, value)
    undo.push(async () => (before !== null ? secrets.set(account, before) : secrets.delete(account)))
  }
  const dropSecret = async (account: string) => {
    const before = await secrets.get(account)
    if (before === null) return
    await secrets.delete(account)
    undo.push(() => secrets.set(account, before))
  }

  let stashed: string | null = null
  try {
    const variants = { ...slotBefore.variants }

    // What the slot is now becomes a variant, unless it is the provider it is staying.
    if (previous && prevKey !== newKey) {
      variants[prevKey!] = previous
      stashed = prevKey
      if (oldSecret !== null) await setSecret(variantAccount(prevKey!), oldSecret)
      else await dropSecret(variantAccount(prevKey!)) // a /login has none: no stale one may stand in
    }
    // A variant of the provider the slot is becoming is stale the moment it is current.
    if (Object.hasOwn(variants, newKey)) {
      delete variants[newKey]
      await dropSecret(variantAccount(newKey))
    }

    if (apiKey) {
      await setSecret(DEFAULT_SLOT, apiKey)
    } else if (oldSecret !== null) {
      try {
        await dropSecret(DEFAULT_SLOT)
      } catch (e) {
        warnings.push(`The old key for "${DEFAULT_SLOT}" is still in the secret store (${(e as Error).message}); it is unused and safe to delete.`)
      }
    }

    store.providers[DEFAULT_SLOT] = profile
    saveStore(paths, store)
    undo.push(async () => saveStore(paths, storeBefore))

    // The first record is the slot as it was, from the beginning of time: everything the
    // transcripts hold before the first switch belongs to it.
    const epochs = [...slotBefore.epochs]
    if (!epochs.length) epochs.push(describeEpoch(previous ?? profile, 0))
    if (epochs[epochs.length - 1]!.preset !== newKey) epochs.push(describeEpoch(profile, now()))
    saveSlot(paths, { version: 1, variants, epochs })
    undo.push(async () => (slotExisted ? saveSlot(paths, slotBefore) : removeSlot(paths)))
  } catch (e) {
    for (const step of undo.reverse()) await step().catch(() => {})
    throw e
  }

  const dir = profileDir(paths, DEFAULT_SLOT)
  if (previous && isOauth(previous) && !isOauth(profile)) {
    const w = stashLogin(dir)
    if (w) warnings.push(w)
  } else if (isOauth(profile) && !(previous && isOauth(previous))) {
    const w = restoreLogin(dir)
    if (w) warnings.push(w)
  } else if (previous && isOauth(previous) && isOauth(profile)) {
    notes.push('The default is still signed in as before: /login keeps the account it had. Use /logout and /login inside Claude Code to switch accounts.')
  }

  return { previous, stashed, warnings, notes, shim: installDefaultShim(paths, DEFAULT_SLOT, launcher) }
}

/** What `default --use` can swap to. */
export function stashedKeys(paths: Paths): string[] {
  return Object.keys(loadSlot(paths).variants).sort()
}

/**
 * Swap the slot to a variant it kept: the same save as `add --default`, with the variant's
 * profile and secret, so the current configuration is kept in its place.
 */
export async function useVariant(deps: SlotDeps, key: string, launcher: string[]): Promise<SlotResult> {
  const { paths, secrets } = deps
  const slot = loadSlot(paths)
  const variant = Object.hasOwn(slot.variants, key) ? slot.variants[key] : undefined
  if (!variant) {
    const have = Object.keys(slot.variants).sort()
    throw new ProfileError(
      have.length
        ? `The default has no stashed "${key}". It has: ${have.join(', ')}.`
        : `The default has nothing stashed. \`ccprovider add --default\` keeps what it replaces.`,
    )
  }
  const secret = isOauth(variant) ? null : await secrets.get(variantAccount(key))
  if (!isOauth(variant) && !secret) {
    throw new ProfileError(
      `The key for the stashed "${key}" is gone from the secret store. Set it up again with \`ccprovider add --default\`, ` +
        `or drop the entry with \`ccprovider default --forget ${key}\`.`,
    )
  }
  return saveDefaultSlot(deps, variant, secret, launcher)
}

/** Drop one stashed variant and its secret. */
export async function forgetVariant(deps: SlotDeps, key: string): Promise<string[]> {
  const { paths, secrets } = deps
  const slot = loadSlot(paths)
  if (!Object.hasOwn(slot.variants, key)) {
    const have = Object.keys(slot.variants).sort()
    throw new ProfileError(have.length ? `The default has no stashed "${key}". It has: ${have.join(', ')}.` : 'The default has nothing stashed.')
  }
  const warnings: string[] = []
  try {
    await secrets.delete(variantAccount(key))
  } catch (e) {
    warnings.push(`The key for the stashed "${key}" is still in the secret store (${(e as Error).message}); it is unused and safe to delete.`)
  }
  delete slot.variants[key]
  saveSlot(paths, slot)
  return warnings
}

/** Everything the slot keeps beside its profile: the stashed secrets and the file. For `rm default`. */
export async function dropSlotFile(deps: SlotDeps): Promise<string[]> {
  const { paths, secrets } = deps
  const warnings: string[] = []
  let slot
  try {
    slot = loadSlot(paths)
  } catch (e) {
    // A damaged file must not stand in the way of removing the profile it belongs to.
    removeSlot(paths)
    return [`${(e as Error).message} — removed it, so any stashed keys it listed stay in the secret store, unused.`]
  }
  for (const key of Object.keys(slot.variants)) {
    try {
      await secrets.delete(variantAccount(key))
    } catch (e) {
      warnings.push(`The key for the stashed "${key}" is still in the secret store (${(e as Error).message}); it is unused and safe to delete.`)
    }
  }
  removeSlot(paths)
  return warnings
}

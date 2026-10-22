import { join } from 'node:path'

import { reconcileLinks } from '../configdir.js'
import { DEFAULT_SLOT, assertSlotWritable, forgetVariant, stashedKeys, useVariant } from '../defaultslot.js'
import { profileDir } from '../paths.js'
import { loadStore, getProfile, ProfileError } from '../profile.js'
import { loadSettings, sessionConfigDir, sharesSessions } from '../settings.js'
import { inspectDefaultShim, installDefaultShim, removeDefaultShim, selfLauncher } from '../shim.js'
import { setupMcp } from '../setup.js'
import { presetKey } from '../slot.js'
import { c, type Paths, type Secrets } from '../ui.js'
import { defaultPathHint, offerRcWrite, offerDefaultPath } from '../pathhint.js'

export interface DefaultFlags {
  off: boolean
  /** Swap the default to a provider it stashed. */
  use?: string
  /** Drop a stashed provider. */
  forget?: string
}

export async function cmdDefault(paths: Paths, secrets: Secrets, name: string | undefined, flags: DefaultFlags): Promise<number> {
  const { off } = flags
  const chosen = [name !== undefined, off, flags.use !== undefined, flags.forget !== undefined].filter(Boolean).length
  if (chosen > 1) {
    console.error('Give a profile, --off, --use or --forget, one at a time.')
    return 1
  }
  if (flags.use !== undefined) return swapTo(paths, secrets, flags.use)
  if (flags.forget !== undefined) {
    for (const w of await forgetVariant({ paths, secrets }, flags.forget)) console.error(c.yellow(`! ${w}`))
    console.log(`Dropped the stashed "${flags.forget}" and its key.`)
    return 0
  }

  if (off) {
    const r = removeDefaultShim(paths)
    if (r === 'removed') console.log('`claude` runs Claude Code as installed again.')
    else if (r === 'absent') console.log('No default profile is set.')
    else console.error(`${join(paths.defaultBinDir, 'claude')} is not a ccprovider wrapper, so it was left alone.`)
    return r === 'foreign' ? 1 : 0
  }

  if (!name) {
    const s = inspectDefaultShim(paths)
    if (s.state === 'absent') {
      console.log('No default profile. `claude` runs Claude Code as installed; `ccprovider default <profile>` changes that.')
      return 0
    }
    if (s.state === 'foreign') {
      console.error(c.yellow(`! ${s.path} is not a ccprovider wrapper, so \`ccprovider default\` leaves it alone.`))
      return 1
    }
    console.log(`\`claude\` runs the "${s.profile}" profile  ${c.dim(s.path)}`)
    if (!s.targetOk) {
      console.log(c.yellow(`  ! The wrapper points at ${s.launcher!.join(' ')}, which is missing or not executable. Run \`ccprovider default ${s.profile}\` again.`))
    }
    if (!Object.hasOwn(loadStore(paths).providers, s.profile!)) {
      console.log(c.yellow(`  ! There is no "${s.profile}" profile any more. \`ccprovider default --off\` removes the wrapper.`))
    }
    const stashed = s.profile === DEFAULT_SLOT ? stashedKeys(paths) : []
    if (stashed.length) {
      console.log(c.dim(`  stashed: ${stashed.join(', ')}  — \`ccprovider default --use <name>\` swaps one in, \`--forget <name>\` drops it`))
    }
    const hint = defaultPathHint(paths, s)
    for (const line of hint) console.log(line)
    await offerRcWrite(paths, hint)
    return 0
  }

  getProfile(loadStore(paths), name)
  const r = installDefaultShim(paths, name, selfLauncher())
  console.log(`${c.green('✓')} \`claude\` now runs the "${name}" profile  ${c.dim(r.path)}${r.action === 'unchanged' ? c.dim('  (it already did)') : ''}`)
  await offerDefaultPath(paths)
  return 0
}

/** `default --use <provider>`: swap the default to what it stashed, with no wizard and no key
 *  typed. The directory stays, so a session started on the other provider can be continued. */
async function swapTo(paths: Paths, secrets: Secrets, key: string): Promise<number> {
  assertSlotWritable(paths)
  const store = loadStore(paths)
  const current = Object.hasOwn(store.providers, DEFAULT_SLOT) ? store.providers[DEFAULT_SLOT] : undefined
  if (current && presetKey(current) === key) {
    console.log(`The default already is ${key}.`)
    return 0
  }

  const r = await useVariant({ paths, secrets }, key, selfLauncher())
  for (const w of r.warnings) console.error(c.yellow(`! ${w}`))
  for (const n of r.notes) console.log(c.dim(`  ${n}`))

  const next = loadStore(paths).providers[DEFAULT_SLOT]!
  const settings = loadSettings(paths)
  const shared = sharesSessions(next, settings)
  if (!shared) reconcileLinks(profileDir(paths, DEFAULT_SLOT), paths.claudeDir)
  // Servers only: the agents and the Explore model in the directory belong to the profile, not
  // to the provider, so they are left as they are.
  for (const line of setupMcp(paths, DEFAULT_SLOT, next, { mcp: r.previous?.mcp, preset: r.previous?.preset }, shared)) console.log(line)

  console.log(`${c.green('✓')} \`claude\` now runs ${c.bold(key)}${r.stashed ? c.dim(`  (${r.stashed} is kept: \`ccprovider default --use ${r.stashed}\` swaps it back)`) : ''}`)
  const was = r.previous ? sessionConfigDir(paths, DEFAULT_SLOT, r.previous, settings) : null
  const now = sessionConfigDir(paths, DEFAULT_SLOT, next, settings)
  if (was && was !== now) {
    console.log(c.yellow(`! The sessions of the other one are in ${was}, and this one runs in ${now}: \`claude --continue\` will not find them.`))
    console.log(c.dim('  Give both the same sharing choice (`ccprovider settings`) to carry a session across.'))
  } else {
    console.log(c.dim('  `claude --continue` picks up the last session in this folder; `claude --resume` lists them.'))
  }
  await offerDefaultPath(paths)
  return 0
}

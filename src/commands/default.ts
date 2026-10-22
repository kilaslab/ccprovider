import { join } from 'node:path'

import { loadStore, getProfile } from '../profile.js'
import { inspectDefaultShim, installDefaultShim, removeDefaultShim, selfLauncher } from '../shim.js'
import { c, type Paths } from '../ui.js'
import { defaultPathHint, offerRcWrite, offerDefaultPath } from '../pathhint.js'

export async function cmdDefault(paths: Paths, name: string | undefined, off: boolean): Promise<number> {
  if (name && off) {
    console.error('Give a profile or --off, not both.')
    return 1
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

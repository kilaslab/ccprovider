import { join } from 'node:path'

import { loadStore } from '../profile.js'
import { listShims, removeShim } from '../shim.js'
import { p } from '../tui/prompts.js'
import { c, type Paths } from '../ui.js'

export async function cmdUninstall(paths: Paths, name: string | undefined, yes: boolean): Promise<number> {
  if (name) {
    const r = removeShim(paths, name)
    console.log(
      r === 'removed' ? `Removed the \`${name}\` command.`
      : r === 'absent' ? `No \`${name}\` command is installed.`
      : `${join(paths.binDir, name)} is not a ccprovider launcher, so it was left alone.`,
    )
    // Only the command goes; the profile stays. Said out loud, because "uninstall" reads
    // like deleting it, and a later `add` of the same name is then refused.
    if (r !== 'foreign' && Object.hasOwn(loadStore(paths).providers, name)) {
      console.log(c.dim(`  The "${name}" profile is still there: \`ccprovider rm ${name}\` deletes it, \`ccprovider install ${name}\` brings the command back.`))
    }
    return r === 'foreign' ? 1 : 0
  }

  const ours = listShims(paths)
  if (!ours.length) { console.log('No ccprovider commands are installed.'); return 0 }
  if (!yes) {
    const ok = await p.confirm({ message: `Remove ${ours.length} command${ours.length === 1 ? '' : 's'}: ${ours.map((s) => s.command).join(', ')}?`, initialValue: false })
    if (p.isCancel(ok) || !ok) { console.log('Cancelled.'); return 1 }
  }
  // Count what actually happened: an entry can be refused or fail, and one failure must
  // not stop the rest or be reported as a removal.
  let removed = 0
  const left: string[] = []
  for (const s of ours) {
    try {
      if (removeShim(paths, s.command) === 'removed') removed++
      else left.push(s.command)
    } catch {
      left.push(s.command)
    }
  }
  console.log(`Removed ${removed} command${removed === 1 ? '' : 's'}. Your profiles are untouched.`)
  if (left.length) console.error(c.yellow(`! Could not remove: ${left.join(', ')}`))
  return left.length ? 1 : 0
}

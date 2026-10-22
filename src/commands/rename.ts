import { loadStore, getProfile } from '../profile.js'
import { renameProfile } from '../rename.js'
import { selfLauncher } from '../shim.js'
import { p } from '../tui/prompts.js'
import { c, type Paths, type Secrets } from '../ui.js'

export async function cmdRename(paths: Paths, secrets: Secrets, from: string, to: string, yes: boolean): Promise<number> {
  const store = loadStore(paths)
  getProfile(store, from)

  if (!yes) {
    const ok = await p.confirm({
      message:
        `Rename "${from}" to "${to}"? Close any running \`${from}\` sessions first — ` +
        `they keep using the old directory and would lose their history.`,
      initialValue: true,
    })
    if (p.isCancel(ok) || !ok) { console.log('Cancelled.'); return 1 }
  }

  const r = await renameProfile({ paths, secrets, store, launcher: selfLauncher() }, from, to)
  console.log(`Renamed "${from}" to "${c.bold(to)}".`)
  console.log(
    r.command === 'moved'
      ? `${c.green('✓')} the \`${from}\` command is now \`${to}\``
      : c.dim(`  \`${from}\` had no command. \`ccprovider install ${to}\` makes one.`),
  )
  if (r.defaultCommand === 'moved') console.log(`${c.green('✓')} \`claude\` now runs "${to}"`)
  for (const w of r.warnings) console.error(c.yellow(`! ${w}`))
  if (r.staleVenvs.length) {
    console.error(
      c.yellow(
        r.staleVenvs.length === 1
          ? '! A Python virtualenv inside the profile still points at the old directory and will not work:'
          : `! ${r.staleVenvs.length} Python virtualenvs inside the profile still point at the old directory and will not work:`,
      ),
    )
    for (const v of r.staleVenvs) console.error(c.dim(`    ${v}`))
    console.error(c.dim('  They are rebuilt on demand by whatever created them; deleting them is safe.'))
  }
  return 0
}

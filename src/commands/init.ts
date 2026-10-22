import { homedir } from 'node:os'

import { detectRcFile } from '../shellrc.js'
import { p } from '../tui/prompts.js'
import { c, type Paths } from '../ui.js'
import { blockLines, writeRcBlock } from '../pathhint.js'

/** `ccprovider init` — put ccprovider's PATH entries into the shell's rc file, between marker
 *  lines, so the default `claude` and the installed commands actually resolve. The one command
 *  that edits a shell profile, and never without an explicit -y or an answer at a terminal. */
export async function cmdInit(paths: Paths, yes: boolean): Promise<number> {
  const rc = detectRcFile(process.env, homedir())
  const lines = blockLines(paths, rc?.file ?? null)
  if (!rc) {
    for (const line of lines) console.log(`  ${line}`)
    console.log(c.dim('  Add that to your shell startup file yourself — `init` only writes the startup file of zsh or bash.'))
    return 1
  }
  if (!yes) {
    if (!process.stdin.isTTY) {
      // A shell startup file is never rewritten unattended: say what would happen, then stop.
      console.log(`Would add to ${rc.file}:`)
      for (const line of lines) console.log(`    ${line}`)
      console.error(c.dim('  Run `ccprovider init -y` to let it, or run it from a terminal to be asked.'))
      return 1
    }
    const ok = await p.confirm({ message: `Add ccprovider's PATH block to ${rc.file}?`, initialValue: true })
    if (p.isCancel(ok) || !ok) { console.log('Cancelled.'); return 1 }
  }
  writeRcBlock(paths, rc.file)
  return 0
}

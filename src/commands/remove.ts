import { join } from 'node:path'

import { getPaths, isInside, profileDir } from '../paths.js'
import { loadStore, getProfile } from '../profile.js'
import { detectStore } from '../secrets/index.js'
import { inspectStatusline } from '../statusline.js'
import { removeProfile } from '../remove.js'
import { p } from '../tui/prompts.js'
import { isClaude, isClaudeToken } from '../types.js'
import { c } from '../ui.js'

export async function cmdRemove(
  paths: ReturnType<typeof getPaths>,
  secrets: Awaited<ReturnType<typeof detectStore>>,
  name: string,
  yes: boolean,
): Promise<number> {
  const store = loadStore(paths)
  getProfile(store, name)

  // The footer's script may live in this profile's directory (the plugin's own session nudge
  // installs it in whichever config directory the session has). Deleting the profile then hides
  // the status bar in every profile, and nothing else would say so before it happens.
  const footer = inspectStatusline(paths.claudeDir, process.env, paths.dirsRoot)
  if (footer.state === 'ours' && footer.misplaced && isInside(footer.misplaced, profileDir(paths, name))) {
    console.log(c.yellow(`! The token footer runs from "${name}"'s directory. Deleting this profile hides the status bar in every profile.`))
    console.log(c.dim('  Run `ccprovider statusline add` first: it moves the footer into the real config directory.'))
  }

  if (!yes) {
    const ok = await p.confirm({
      message: isClaude(getProfile(store, name))
        ? `Delete profile "${name}", its Claude ${isClaudeToken(getProfile(store, name)) ? 'token' : 'login'} and its session history?`
        : `Delete profile "${name}", its API key and its session history?`,
      initialValue: false,
    })
    if (p.isCancel(ok) || !ok) { console.log('Cancelled.'); return 1 }
  }

  const r = await removeProfile({ paths, secrets, store }, name)
  for (const w of r.warnings) console.error(c.yellow(`! ${w}`))
  console.log(`Removed "${name}". Your ~/.claude is untouched.`)
  if (r.defaultCommand === 'removed') console.log(`Removed the default \`claude\` command too: \`claude\` runs Claude Code as installed again.`)
  if (r.command === 'removed') console.log(`Removed the \`${name}\` command.`)
  else if (r.command === 'foreign') console.log(c.dim(`${join(paths.binDir, name)} is not a ccprovider launcher, so it was left alone.`))
  return 0
}

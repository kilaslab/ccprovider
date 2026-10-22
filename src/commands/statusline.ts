import { addStatusline, compareVersions, inspectStatusline, removeStatusline, STATUSLINE_SOURCE } from '../statusline.js'
import { c, type Paths } from '../ui.js'

export async function cmdStatusline(paths: Paths, sub: string | undefined): Promise<number> {
  if (sub !== undefined && sub !== 'add' && sub !== 'rm' && sub !== 'remove') {
    console.error(`Unknown statusline command "${sub}". Use: ccprovider statusline [add|rm]`)
    return 1
  }

  if (sub === 'add') {
    // Only when there is something to do: python is probed and the installer run before anything
    // else is printed, and "installing" over an "already up to date" would be wrong.
    const now = inspectStatusline(paths.claudeDir, process.env, paths.dirsRoot)
    const current = now.state === 'ours' && now.working && !now.misplaced && now.version !== undefined && compareVersions(now.version, STATUSLINE_SOURCE.version) >= 0
    if (!current) console.log(c.dim('Installing the token footer (it needs python, and a short download the first time)...'))
    const r = await addStatusline({ paths })
    if (r.action === 'already') {
      console.log(`${c.green('✓')} token footer already installed and up to date`)
      return 0
    }
    if (r.action === 'combined') {
      console.log(`${c.green('✓')} your status line already runs the token badge; its copy was refreshed, and the status line is as it was`)
      for (const line of r.output) console.log(c.dim(`  ${line}`))
      return 0
    }
    console.log(`${c.green('✓')} token footer installed${r.chained ? ' (after your previous status line)' : ''}  ${c.dim(`from ${r.from === 'plugin' ? 'the Claude plugin copy' : r.from === 'cache' ? 'the cached download' : 'a hash-checked download'}`)}`)
    for (const line of r.output) console.log(c.dim(`  ${line}`))
    console.log(c.dim('  Shown in every profile, since they share settings.json. New sessions pick it up.'))
    console.log(c.dim('  Only context use is on by default. Read docs/statusline.md before turning on the token or cost segments for a non-Anthropic provider.'))
    return 0
  }

  if (sub === 'rm' || sub === 'remove') {
    const r = await removeStatusline({ paths })
    if (r.action === 'not-installed') {
      console.log('The token footer is not installed, so there is nothing to remove.')
      return 0
    }
    if (r.action === 'combined') {
      console.log('Your own status line script runs the token badge, and ccprovider does not edit it. Take the call to tokens_statusline.py out of that script.')
      return 0
    }
    console.log('Removed the token footer.')
    for (const line of r.output) console.log(c.dim(`  ${line}`))
    return 0
  }

  const s = inspectStatusline(paths.claudeDir, process.env, paths.dirsRoot)
  if (s.state === 'absent') {
    console.log("Token footer: not installed. `ccprovider statusline add` shows context use in Claude Code's footer.")
  } else if (s.state === 'foreign') {
    console.log(`Another status line is in use: ${s.command}`)
    console.log(c.dim('  `ccprovider statusline add` puts the token footer after it. Once added, `ccprovider statusline rm` takes the footer off and puts yours back.'))
  } else if (!s.working) {
    console.log(c.yellow('! Token footer installed, but the script or interpreter it runs is missing, which hides the whole status bar.'))
    console.log(c.dim('  Run `ccprovider statusline add` to repair it.'))
    return 1
  } else {
    if (s.misplaced) {
      console.log(c.yellow(`! The footer's script lives in a profile's directory (${s.misplaced}). Removing that profile would hide the status bar in every profile.`))
      console.log(c.dim('  `ccprovider statusline add` moves it into the real config directory.'))
    }
    const stale = s.version === undefined || compareVersions(s.version, STATUSLINE_SOURCE.version) < 0
    console.log(`${c.green('✓')} token footer installed  ${c.dim(`v${s.version ?? '?'}${s.chained ? ', after your previous status line' : ''}${s.combined ? ', run by your own status line script' : ''}`)}`)
    if (stale && !s.combined) console.log(c.dim(`  ccprovider ships v${STATUSLINE_SOURCE.version}; \`ccprovider statusline add\` updates it.`))
  }
  return 0
}

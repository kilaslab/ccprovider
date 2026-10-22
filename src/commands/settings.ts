import { loadStore } from '../profile.js'
import { applyGlobalShare, applyProfileShare, describeShare, loadSettings, type ShareChange } from '../settings.js'
import { isOauth } from '../types.js'
import { c, type Paths } from '../ui.js'

/** `ccprovider settings` — install-wide settings with per-profile overrides. At a terminal a bare
 *  run opens a menu; piped, it shows how every profile resolves. `set` changes the global file or
 *  one profile's override, `unset` drops an override so the profile inherits again — the forms a
 *  script uses. */
export async function cmdSettings(paths: Paths, args: string[]): Promise<number> {
  const [sub, key, value, profileName] = args
  if (!sub) {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      const { runSettingsMenu } = await import('../tui/settings.js')
      return runSettingsMenu(paths)
    }
    const store = loadStore(paths)
    const settings = loadSettings(paths)
    console.log(`${c.bold('settings')}  ${c.dim(paths.settingsFile)}`)
    console.log(`  shareSessions  ${c.bold(String(settings.shareSessions))}  ${c.dim('(global default)')}`)
    for (const [n, pr] of Object.entries(store.providers)) {
      const line = describeShare(pr, settings)
      // An override is the part worth noticing; "inherits" and "never" are the quiet defaults.
      console.log(`  ${c.bold(n.padEnd(14))} ${isOauth(pr) || pr.shareSessions === undefined ? c.dim(line) : line}`)
    }
    // On stderr, so a script that reads the list from stdout gets the list and nothing else.
    console.error(c.dim('\n  change: run `ccprovider settings` in a terminal, or `ccprovider settings set shareSessions true|false [profile]`'))
    return 0
  }

  const report = (r: ShareChange) => {
    console.log(r.changed ? `${c.green('✓')} ${r.done}` : r.done)
    for (const note of r.notes) console.log(c.dim(`  ${note}`))
  }

  if (sub === 'set') {
    if (args.length > 4) { console.error('Too many arguments: settings set shareSessions true|false [profile]'); return 1 }
    if (key !== 'shareSessions') {
      console.error(key === undefined ? `\`ccprovider settings set\` needs a setting and a value: settings set shareSessions true|false [profile]` : `Unknown setting "${key}". "shareSessions" is the only one.`)
      return 1
    }
    if (value !== 'true' && value !== 'false') {
      console.error(`shareSessions takes true or false, not "${value ?? ''}".`)
      return 1
    }
    report(profileName !== undefined ? applyProfileShare(paths, profileName, value === 'true') : applyGlobalShare(paths, value === 'true'))
    return 0
  }

  if (sub === 'unset') {
    if (args.length > 3) { console.error('Too many arguments: settings unset shareSessions <profile>'); return 1 }
    if (key !== 'shareSessions' || !value) {
      console.error('Usage: ccprovider settings unset shareSessions <profile> — the global value is never unset; set it to false.')
      return 1
    }
    report(applyProfileShare(paths, value, undefined))
    return 0
  }

  console.error(`Unknown settings command "${sub}". Use: settings, settings set shareSessions true|false [profile], settings unset shareSessions <profile>`)
  return 1
}

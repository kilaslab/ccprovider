import { getPaths } from '../paths.js'
import { loadStore, getProfile } from '../profile.js'
import { loadSettings, sharesSessions } from '../settings.js'
import { detectStore } from '../secrets/index.js'
import { runDoctor, orphanChecks, defaultChecks, statuslineChecks, worstStatus, type Check } from '../doctor.js'
import { currentDefaultProfile } from '../shim.js'
import { isClaude } from '../types.js'
import { c } from '../ui.js'

export async function cmdDoctor(
  paths: ReturnType<typeof getPaths>,
  secrets: Awaited<ReturnType<typeof detectStore>>,
  name: string | undefined,
): Promise<number> {
  const store = loadStore(paths)
  const names = name ? [name] : Object.keys(store.providers)
  // Not an early return: what belongs to the install and not to a profile (the default
  // `claude`, the footer, leftover commands) can be broken with no profile left at all.
  if (!names.length) console.log('No profiles yet. Run `ccprovider add`.')

  let worst: 'ok' | 'warn' | 'fail' = 'ok'
  for (const n of names) {
    const profile = getProfile(store, n)
    console.log(`\n${c.bold(n)}  ${c.dim(isClaude(profile) ? 'Claude subscription' : profile.baseUrl)}`)
    const checks = await runDoctor(n, profile, paths, secrets, { shared: sharesSessions(profile, loadSettings(paths)) })
    for (const check of checks) render(check)
    const s = worstStatus(checks)
    if (s === 'fail') worst = 'fail'
    else if (s === 'warn' && worst === 'ok') worst = 'warn'
  }

  // Findings that belong to the install and not to any one profile: each is shown once, under
  // its own heading, and folded into the exit status like a profile's.
  const section = (title: string, checks: Check[]) => {
    if (!checks.length) return
    console.log(`\n${c.bold(title)}`)
    for (const check of checks) render(check)
    const s = worstStatus(checks)
    if (s === 'fail') worst = 'fail'
    else if (s === 'warn' && worst === 'ok') worst = 'warn'
  }

  // Launchers whose profile is gone belong to no profile's report: a whole-install run only.
  if (!name) section('leftover commands', orphanChecks(paths, names))
  if (!name) section('token footer', statuslineChecks(paths))
  // The plain `claude` command: a whole run, or a question about the very profile it runs.
  if (!name || currentDefaultProfile(paths) === name) {
    section('default command', defaultChecks(paths, Object.keys(store.providers), process.env))
  }
  return worst === 'fail' ? 1 : 0
}

function render(check: Check): void {
  const mark = check.status === 'ok' ? c.green('✓') : check.status === 'warn' ? c.yellow('!') : c.red('✗')
  console.log(`  ${mark} ${check.label}${check.detail ? c.dim(`  ${check.detail}`) : ''}`)
}

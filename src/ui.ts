import { getPaths } from './paths.js'
import { validateName } from './profile.js'
import type { AgentResult } from './agents.js'
import { detectStore } from './secrets/index.js'
import { runOffer } from './statusline.js'
import { installCommandFor, selfLauncher } from './shim.js'
import { p } from './tui/prompts.js'

export const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
}

export function requireName(name: string | undefined, cmd: string, what = 'a profile name'): string {
  if (!name) {
    console.error(`\`ccprovider ${cmd}\` needs ${what}. Run \`ccprovider ls\` to see the profiles.`)
    process.exit(1)
  }
  // Normalised here so every downstream use — store lookup, profile dir, keychain
  // account — agrees on one spelling.
  return validateName(name)
}

export type Paths = ReturnType<typeof getPaths>

export type Secrets = Awaited<ReturnType<typeof detectStore>>

export interface InstallOutcome {
  ok: boolean
  usable: boolean
  line: string
}

/** Print-ready result of installing `name` as a command. The decisions live in
 *  `installCommandFor`, where they are tested; this only words them. */
export function installCommand(paths: Paths, name: string, opts: { automatic: boolean }): InstallOutcome {
  const r = installCommandFor(paths, name, selfLauncher, opts)
  if (!r.ok) return { ok: false, usable: false, line: c.yellow(`! command \`${name}\` not installed: ${r.error}`) }
  const notes = [r.shadows ? `shadows ${r.shadows}` : '', r.shadowedBy ? `but ${r.shadowedBy} comes first on PATH` : ''].filter(Boolean)
  return {
    ok: true,
    usable: r.usable,
    line: `${c.green('✓')} command \`${name}\` ${r.action}  ${c.dim(r.path!)}${notes.length ? c.yellow(`  (${notes.join('; ')})`) : ''}`,
  }
}

/** The line to say after adding a `/login` profile, whose first launch needs the login. */
export function loginHint(who: string): string {
  return c.dim(`  First launch: type /login inside Claude Code and sign in with the account for ${who}.`)
}

export function agentLine(r: AgentResult): string {
  const label = r.id === 'explore' ? 'Explore' : r.id
  return r.action === 'failed' || r.action === 'kept'
    ? c.yellow(`! agent ${label}: ${r.action === 'kept' ? 'left as it is' : 'not installed'}${r.detail ? ` — ${r.detail}` : ''}`)
    : `${c.green('✓')} agent ${label} ${r.action === 'absent' ? 'was not installed' : r.action}`
}

/** The token footer is install-wide: statusLine lives in settings.json, which every profile
 *  links to. So it is offered once, on `add`, and a "no" is remembered. */
export async function offerStatusline(paths: Paths, enabled: boolean): Promise<string[]> {
  if (!enabled) return []
  const r = await runOffer({ paths }, async ({ broken, foreign }) => {
    const ok = await p.confirm({
      message: broken
        ? 'The token footer is installed but its script is missing, which hides the whole status bar. Repair it?'
        : `Show context use in Claude Code's footer? (cc-token-statusline by Alfafis, MIT. One install covers every profile${
            foreign ? ', and your current status line stays in front of it' : ''
          })`,
      initialValue: true,
    })
    if (ok === true) console.log(c.dim('Installing the token footer (it needs python, and a short download the first time)...'))
    return p.isCancel(ok) ? 'cancel' : ok ? 'yes' : 'no'
  })

  switch (r.outcome) {
    case 'not-needed': return []
    case 'cancelled': return [c.dim('  Footer skipped for now. `ccprovider statusline add` installs it any time.')]
    case 'declined': return [c.dim('  No footer. `ccprovider statusline add` installs it any time.')]
    case 'installed':
      return r.combined
        ? [`${c.green('✓')} your status line already runs the token badge; its copy was refreshed`]
        : [`${c.green('✓')} token footer installed${r.chained ? ' (after your previous status line)' : ''}  ${c.dim('shown in every profile; new sessions pick it up')}`]
    // The profile is already saved: like MCP and agents, a failure here only warns.
    case 'failed': return [c.yellow(`! token footer not installed: ${r.error}`), c.dim('  Run `ccprovider statusline add` to try again.')]
  }
}

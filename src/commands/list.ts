import { getPaths } from '../paths.js'
import { loadStore } from '../profile.js'
import { loadSettings, sharesSessions } from '../settings.js'
import { missingSlots } from '../launch.js'
import { detectStore } from '../secrets/index.js'
import { DEFAULT_SLOT, stashedKeys } from '../defaultslot.js'
import { currentDefaultProfile, inspectShim } from '../shim.js'
import { isClaudeToken, isOauth } from '../types.js'
import { c, type Paths } from '../ui.js'

/** The "command" line of `ls`. The profile behind the default `claude` has no launcher of its own. */
function commandLine(paths: Paths, n: string): string {
  // Only the slot: any other profile can be the default and still have a launcher of its own.
  if (n === DEFAULT_SLOT && currentDefaultProfile(paths) === n) return `  ${c.dim('command')} ${c.green('claude')}  ${c.dim('(the default)')}`
  const s = inspectShim(paths, n)
  return s.state === 'ours' ? `  ${c.dim('command')} ${c.green(n)}`
    : s.state === 'foreign' ? `  ${c.dim('command')} ${c.yellow(`\`${n}\` is taken by another program`)}`
    : `  ${c.dim(`no command — \`ccprovider install ${n}\``)}`
}

export async function cmdList(paths: ReturnType<typeof getPaths>, secrets: Awaited<ReturnType<typeof detectStore>>): Promise<number> {
  const store = loadStore(paths)
  const settings = loadSettings(paths)
  const names = Object.keys(store.providers)
  if (!names.length) {
    console.log('No profiles yet. Run `ccprovider add` to create one.')
    return 0
  }
  // Under the default, the providers it stashed: not profiles, so not listed as ones.
  const stashedLine = (n: string): string[] => {
    const keys = n === DEFAULT_SLOT ? stashedKeys(paths) : []
    return keys.length ? [`  ${c.dim(`stashed: ${keys.join(', ')}  — \`ccprovider default --use <name>\``)}`] : []
  }
  for (const n of names) {
    const pr = store.providers[n]!
    if (isOauth(pr)) {
      console.log(`${c.bold(n.padEnd(14))} ${c.green('Claude subscription')}`)
      console.log(`  ${c.dim('own login in its profile directory — /login on first launch')}`)
      console.log(commandLine(paths, n))
      for (const line of stashedLine(n)) console.log(line)
      continue
    }
    const hasKey = (await secrets.get(n)) != null
    const missing = missingSlots(pr)
    const token = isClaudeToken(pr)
    const flag = !hasKey ? c.red(token ? 'no token' : 'no key') : missing.length ? c.yellow(`unmapped: ${missing.join(',')}`) : c.green(token ? 'Claude subscription' : 'ready')
    console.log(`${c.bold(n.padEnd(14))} ${flag}`)
    console.log(`  ${c.dim(token ? 'setup-token, sent to Anthropic as CLAUDE_CODE_OAUTH_TOKEN' : pr.baseUrl)}`)
    if (sharesSessions(pr, settings)) {
      console.log(c.dim(`shared with ${paths.claudeDir} — sessions and todos${isClaudeToken(pr) ? '' : ', and credentials,'} are the plain claude's`))
    }
    console.log(commandLine(paths, n))
    for (const line of stashedLine(n)) console.log(line)
    if (token) continue
    const a = pr.aliases
    const pair = (x?: string, y?: string) => (x === y ? (x ?? '—') : `${x ?? '—'} / ${y ?? '—'}`)
    const start = pr.defaultModel && pr.defaultModel !== a.opus ? ` · start ${pr.defaultModel}` : ''
    console.log(`  ${c.dim(`opus+sonnet ${pair(a.opus, a.sonnet)} · haiku+subagent ${pair(a.haiku, a.subagent)}${start}`)}`)
  }
  return 0
}

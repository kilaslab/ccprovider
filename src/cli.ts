#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPaths, profileDir } from './paths.js'
import { loadStore, saveStore, getProfile, validateName, ProfileError } from './profile.js'
import { reconcileLinks, removeProfileDir } from './configdir.js'
import { AGENT_CATALOG, AGENT_SOURCE, installAgents, listInstalled, readExplore, removeAgents, setExplore, syncAgents, type AgentResult } from './agents.js'
import { buildEnv, describeEnv, findClaude, missingSlots, LaunchError } from './launch.js'
import { detectStore } from './secrets/index.js'
import { runDoctor, orphanChecks, worstStatus, type Check } from './doctor.js'
import { claudeRunner, readInstalledMcp, resolveServers, resolveUnwanted, syncMcp } from './mcp.js'
import { findPreset } from './presets.js'
import { removeProfile } from './remove.js'
import { renameProfile } from './rename.js'
import { binDirOnPath, inspectShim, installCommandFor, listShims, removeShim, selfLauncher } from './shim.js'
import { p } from './tui/prompts.js'
import { shellQuote } from './shell.js'
import { isOauth, type Profile } from './types.js'

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
}

const USAGE = `${c.bold('ccprovider')} — run Claude Code against any Anthropic-compatible provider

  ${c.bold('ccprovider add')}                      set up a provider profile
  ${c.bold('ccprovider ls')}                       list profiles
  ${c.bold('ccprovider use')} <name> [-m tier]     launch Claude Code with that profile
  ${c.bold('ccprovider edit')} <name>              change a profile
  ${c.bold('ccprovider rename')} <old> <new>       rename a profile, its key, its history and its command
  ${c.bold('ccprovider rm')} <name>                delete a profile, its key and its command (also: delete)
  ${c.bold('ccprovider install')} [name]           make a profile a command:  glm  instead of  ccprovider use glm
  ${c.bold('ccprovider uninstall')} [name]         remove that command
  ${c.bold('ccprovider doctor')} [name]            check a profile end to end
  ${c.bold('ccprovider env')} <name>               print the exports it would set
  ${c.bold('ccprovider agents')} <name>            list a profile's agents and its Explore model
  ${c.bold('ccprovider agents add')} <name> [id…]  install agents (no IDs: pick from the list)
  ${c.bold('ccprovider agents rm')} <name> <id…>   remove agents (-y also removes ones you edited)
  ${c.bold('ccprovider agents explore')} <name> <haiku|sonnet|opus|model-id|default>
                                      choose the model the Explore subagent runs on

Options
  -m, --model <tier|id>   opus | sonnet | haiku | opusplan | a provider model ID
  --refresh               re-fetch the provider's model list
  --no-install            with add: do not install the profile as a command
  -y, --yes               skip confirmation prompts
  -h, --help              this text

Anything after ${c.bold('--')} is passed straight to claude:
  ccprovider use deepseek -- --resume
An installed command does the same for you:
  deepseek --resume
`

async function main(argv: string[]): Promise<number> {
  const dashdash = argv.indexOf('--')
  const own = dashdash === -1 ? argv : argv.slice(0, dashdash)
  const passthrough = dashdash === -1 ? [] : argv.slice(dashdash + 1)

  const { values, positionals } = parseArgs({
    args: own,
    allowPositionals: true,
    options: {
      model: { type: 'string', short: 'm' },
      refresh: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
      // Declared by its full name: parseArgs's `allowNegative` needs a newer Node than
      // this tool's floor, and the flag is only ever meant negatively.
      'no-install': { type: 'boolean', default: false },
    },
  })

  const [cmd, name, name2] = positionals
  if (values.version) { console.log(version()); return 0 }
  if (values.help || !cmd || cmd === 'help') { console.log(USAGE); return cmd || values.help ? 0 : 1 }

  const paths = getPaths()
  const secrets = await detectStore()

  switch (cmd) {
    case 'add': return cmdAdd(paths, secrets, values.refresh, !values['no-install'])
    case 'ls': case 'list': return cmdList(paths, secrets)
    case 'use': return cmdUse(paths, secrets, requireName(name, 'use'), values.model ?? null, passthrough)
    case 'edit': return cmdEdit(paths, secrets, requireName(name, 'edit'), values.refresh)
    case 'rename': case 'mv': return cmdRename(paths, secrets, requireName(name, 'rename'), requireName(name2, 'rename', 'the new name'), values.yes)
    case 'rm': case 'remove': case 'delete': return cmdRemove(paths, secrets, requireName(name, 'rm'), values.yes)
    case 'install': return cmdInstall(paths, name ? validateName(name) : undefined)
    case 'uninstall': return cmdUninstall(paths, name ? validateName(name) : undefined, values.yes)
    case 'doctor': return cmdDoctor(paths, secrets, name ? validateName(name) : undefined)
    case 'env': return cmdEnv(paths, secrets, requireName(name, 'env'))
    case 'agents': return cmdAgents(paths, positionals.slice(1), values.yes)
    default:
      console.error(`Unknown command "${cmd}".\n`)
      console.log(USAGE)
      return 1
  }
}

function requireName(name: string | undefined, cmd: string, what = 'a profile name'): string {
  if (!name) {
    console.error(`\`ccprovider ${cmd}\` needs ${what}. Run \`ccprovider ls\` to see the profiles.`)
    process.exit(1)
  }
  // Normalised here so every downstream use — store lookup, profile dir, keychain
  // account — agrees on one spelling.
  return validateName(name)
}

type Paths = ReturnType<typeof getPaths>
type Secrets = Awaited<ReturnType<typeof detectStore>>

interface InstallOutcome {
  ok: boolean
  usable: boolean
  line: string
}

/** Print-ready result of installing `name` as a command. The decisions live in
 *  `installCommandFor`, where they are tested; this only words them. */
function installCommand(paths: Paths, name: string, opts: { automatic: boolean }): InstallOutcome {
  const r = installCommandFor(paths, name, selfLauncher, opts)
  if (!r.ok) return { ok: false, usable: false, line: c.yellow(`! command \`${name}\` not installed: ${r.error}`) }
  const notes = [r.shadows ? `shadows ${r.shadows}` : '', r.shadowedBy ? `but ${r.shadowedBy} comes first on PATH` : ''].filter(Boolean)
  return {
    ok: true,
    usable: r.usable,
    line: `${c.green('✓')} command \`${name}\` ${r.action}  ${c.dim(r.path!)}${notes.length ? c.yellow(`  (${notes.join('; ')})`) : ''}`,
  }
}

/** Printed once after however many commands were installed: it is about the directory,
 *  not any one command. */
function pathHint(paths: Paths): string[] {
  if (binDirOnPath(paths.binDir, process.env.PATH)) return []
  return [
    c.yellow(`  ${paths.binDir} is not on your PATH, so installed commands will not resolve yet.`),
    c.dim(`  bash/zsh: export PATH="${paths.binDir}:$PATH"   (add it to your shell profile)`),
  ]
}

/** Bring the profile's Claude config in line with its enabled MCP servers. `previous`
 *  is what was enabled before, so servers the user just switched off can be removed.
 *  Like the command, this only ever warns. */
function setupMcp(paths: Paths, name: string, profile: Profile, previous: string[]): string[] {
  const preset = profile.preset ? findPreset(profile.preset) : undefined
  if (!preset?.mcp) return []
  const enabled = profile.mcp ?? []
  const { region, servers: wanted } = resolveServers(profile, preset)

  // Servers to take away: those just switched off — and, when the endpoint is outside
  // every known region, everything enabled. A definition registered for the provider's
  // MCP host has a header helper that sends this profile's key there, which is right for
  // the provider's own endpoint and a leak for a gateway.
  const drop = new Set(previous.filter((id) => !enabled.includes(id)))
  if (!region) for (const id of enabled) drop.add(id)
  const unwanted = resolveUnwanted([...drop], preset)
  if (!wanted.length && !unwanted.length) return []

  const dir = profileDir(paths, name)
  let claude: string
  try {
    claude = findClaude(process.env as Record<string, string>)
  } catch (e) {
    return [c.yellow(`! MCP servers not set up: ${(e as Error).message}`), c.dim(`  Run \`ccprovider edit ${name}\` once claude is installed.`)]
  }

  const results = syncMcp({ run: claudeRunner(claude, dir), installed: readInstalledMcp(dir), wanted, unwanted })
  return results.map((r) =>
    r.action === 'failed' || r.action === 'kept'
      ? c.yellow(`! MCP ${r.id}: ${r.action}${r.detail ? ` — ${r.detail}` : ''}`)
      : `${c.green('✓')} MCP ${r.id} ${r.action}`,
  )
}

/** Bring the profile's agents and Explore override in line with the wizard's answer.
 *  Like MCP, a failure here only warns: the profile itself is already saved. */
async function setupAgents(paths: Paths, name: string, wanted: string[], explore: string | null): Promise<string[]> {
  const dir = profileDir(paths, name)
  const results = [
    ...(await syncAgents(dir, paths.claudeDir, wanted, { cacheDir: paths.cacheDir })),
    setExplore(dir, paths.claudeDir, explore),
  ]
  // Back to the plain shared link when nothing of the profile's own is left.
  reconcileLinks(dir, paths.claudeDir)
  return results.filter((r) => r.action !== 'unchanged' && r.action !== 'absent').map(agentLine)
}

function agentLine(r: AgentResult): string {
  const label = r.id === 'explore' ? 'Explore' : r.id
  return r.action === 'failed' || r.action === 'kept'
    ? c.yellow(`! agent ${label}: ${r.action === 'kept' ? 'left as it is' : 'not installed'}${r.detail ? ` — ${r.detail}` : ''}`)
    : `${c.green('✓')} agent ${label} ${r.action === 'absent' ? 'was not installed' : r.action}`
}

const AGENT_SUBCOMMANDS = ['ls', 'list', 'add', 'rm', 'remove', 'explore']

/** `ccprovider agents [ls|add|rm|explore] <name> …` — a bare `agents <name>` lists. */
async function cmdAgents(paths: Paths, args: string[], yes: boolean): Promise<number> {
  const [sub, rawName, ...rest] = AGENT_SUBCOMMANDS.includes(args[0] ?? '') ? args : ['ls', ...args]
  const name = requireName(rawName, `agents ${sub}`)
  const profile = getProfile(loadStore(paths), name)
  const dir = profileDir(paths, name)
  reconcileLinks(dir, paths.claudeDir)

  let results: AgentResult[]
  switch (sub) {
    case 'add': {
      const ids = rest
      if (!ids.length) {
        if (!process.stdin.isTTY) {
          console.error(`Name the agents to add: ${AGENT_CATALOG.map((a) => a.id).join(', ')}`)
          return 1
        }
        const { chooseAgents } = await import('./tui/wizard.js')
        const installed = listInstalled(dir).filter((a) => a.known).map((a) => a.id)
        // The list starts from what is installed, so unticking one here removes it.
        results = await syncAgents(dir, paths.claudeDir, await chooseAgents(installed.length ? installed : null), { cacheDir: paths.cacheDir })
        break
      }
      results = await installAgents(dir, paths.claudeDir, ids, { cacheDir: paths.cacheDir })
      break
    }
    case 'rm': case 'remove':
      if (!rest.length) { console.error(`\`ccprovider agents rm ${name}\` needs the agents to remove.`); return 1 }
      results = removeAgents(dir, rest, { force: yes })
      break
    case 'explore': {
      const model = rest[0]
      if (!model) { console.error(`\`ccprovider agents explore ${name}\` needs a model: haiku, sonnet, opus, a model ID, or default.`); return 1 }
      try {
        results = [setExplore(dir, paths.claudeDir, model === 'default' ? null : model)]
      } catch (e) {
        console.error((e as Error).message)
        return 1
      }
      break
    }
    default:
      printAgents(paths, name, profile, dir)
      return 0
  }

  reconcileLinks(dir, paths.claudeDir)
  for (const r of results) console.log(agentLine(r))
  return results.some((r) => r.action === 'failed') ? 1 : 0
}

function printAgents(paths: Paths, name: string, profile: Profile, dir: string): void {
  const installed = new Map(listInstalled(dir).map((a) => [a.id, a]))
  console.log(`${c.bold(name)} agents  ${c.dim(`from ${AGENT_SOURCE.repo} @ ${AGENT_SOURCE.commit.slice(0, 7)}, MIT`)}`)
  for (const a of AGENT_CATALOG) {
    const got = installed.get(a.id)
    const mark = !got ? c.dim('·') : got.modified ? c.yellow('!') : c.green('✓')
    console.log(`  ${mark} ${a.id.padEnd(24)}${c.dim(got?.modified ? 'edited since it was installed' : a.summary)}`)
  }
  for (const a of installed.values()) {
    if (!a.known) console.log(`  ${c.yellow('!')} ${a.id.padEnd(24)}${c.dim('no longer in the catalog')}`)
  }

  const explore = readExplore(dir)
  const mapped = explore ? profile.aliases[explore.model as keyof Profile['aliases']] : undefined
  console.log(
    `  Explore  ${explore ? `${explore.model}${mapped ? ` → ${mapped}` : ''}${explore.modified ? c.yellow('  (edited)') : ''}` : c.dim('built-in, on the session model')}`,
  )
  let shared = 0
  try { shared = readdirSync(join(paths.claudeDir, 'agents')).length } catch { /* none */ }
  if (shared) console.log(c.dim(`  + ${shared} shared from ${join(paths.claudeDir, 'agents')}`))
  console.log(c.dim(`  ccprovider agents add|rm ${name} <id> · ccprovider agents explore ${name} <haiku|sonnet|opus|default>`))
}

async function cmdAdd(paths: Paths, secrets: Secrets, refresh: boolean, install: boolean): Promise<number> {
  const store = loadStore(paths)
  const { runWizard } = await import('./tui/wizard.js')
  const result = await runWizard(paths, null, Object.keys(store.providers), refresh)
  if ('editInstead' in result) return cmdEdit(paths, secrets, result.editInstead, refresh)
  // Deleted only now that the new one is confirmed: cancelling anywhere before this
  // leaves the old profile exactly as it was.
  if (result.replace) {
    const r = await removeProfile({ paths, secrets, store }, result.name)
    for (const w of r.warnings) console.error(c.yellow(`! ${w}`))
    console.log(c.dim(`Replaced the previous "${result.name}" profile and its session history.`))
  }
  store.providers[result.name] = result.profile
  saveStore(paths, store)
  if (result.apiKey) await secrets.set(result.name, result.apiKey)
  const dir = profileDir(paths, result.name)
  reconcileLinks(dir, paths.claudeDir)

  for (const line of setupMcp(paths, result.name, result.profile, [])) console.log(line)
  for (const line of await setupAgents(paths, result.name, result.agents, result.explore)) console.log(line)
  const installed = install ? installCommand(paths, result.name, { automatic: true }) : null
  if (installed) {
    console.log(installed.line)
    if (installed.ok) for (const line of pathHint(paths)) console.log(line)
  }
  // Only promise the short form when it will actually work: a command that was skipped,
  // is off PATH, or is shadowed would launch something else.
  const use = c.bold(`ccprovider use ${result.name}`)
  if (isOauth(result.profile)) {
    console.log(c.dim(`  First launch: type /login inside Claude Code and sign in with the account for "${result.name}".`))
  }
  p.outro(
    installed?.usable ? `Saved. Launch it with  ${c.bold(result.name)}  or  ${use}`
    : install ? `Saved. Launch it with  ${use}`
    : `Saved. Launch it with  ${use}   (\`ccprovider install ${result.name}\` makes it a command)`,
  )
  return 0
}

async function cmdEdit(paths: Paths, secrets: Secrets, name: string, refresh: boolean): Promise<number> {
  const store = loadStore(paths)
  const profile = getProfile(store, name)
  if (isOauth(profile)) {
    console.log(`"${name}" is a Claude subscription profile: there is no endpoint or key to edit. Use /login inside it to switch accounts.`)
    return 0
  }
  const apiKey = await secrets.get(name)
  const { runWizard } = await import('./tui/wizard.js')
  const result = await runWizard(paths, { name, profile, apiKey }, [], refresh)
  // Only `add` can be redirected to an edit; editing never asks for a name.
  if ('editInstead' in result) return 1
  store.providers[name] = result.profile
  saveStore(paths, store)
  if (result.apiKey) await secrets.set(name, result.apiKey)
  reconcileLinks(profileDir(paths, name), paths.claudeDir)
  for (const line of setupMcp(paths, name, result.profile, profile.mcp ?? [])) console.log(line)
  for (const line of await setupAgents(paths, name, result.agents, result.explore)) console.log(line)
  p.outro('Updated.')
  return 0
}

async function cmdRename(paths: Paths, secrets: Secrets, from: string, to: string, yes: boolean): Promise<number> {
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

async function cmdInstall(paths: Paths, name: string | undefined): Promise<number> {
  const store = loadStore(paths)
  if (name) getProfile(store, name)
  const names = name ? [name] : Object.keys(store.providers)
  if (!names.length) { console.log('No profiles yet. Run `ccprovider add`.'); return 0 }

  let failed = false
  for (const n of names) {
    const r = installCommand(paths, n, { automatic: false })
    console.log(r.line)
    if (!r.ok) failed = true
  }
  for (const line of pathHint(paths)) console.log(line)
  return failed ? 1 : 0
}

async function cmdUninstall(paths: Paths, name: string | undefined, yes: boolean): Promise<number> {
  if (name) {
    const r = removeShim(paths, name)
    console.log(
      r === 'removed' ? `Removed the \`${name}\` command.`
      : r === 'absent' ? `No \`${name}\` command is installed.`
      : `${join(paths.binDir, name)} is not a ccprovider launcher, so it was left alone.`,
    )
    // Only the command goes; the profile stays. Said out loud, because "uninstall" reads
    // like deleting it, and a later `add` of the same name is then refused.
    if (r !== 'foreign' && name in loadStore(paths).providers) {
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

async function cmdList(paths: ReturnType<typeof getPaths>, secrets: Awaited<ReturnType<typeof detectStore>>): Promise<number> {
  const store = loadStore(paths)
  const names = Object.keys(store.providers)
  if (!names.length) {
    console.log('No profiles yet. Run `ccprovider add` to create one.')
    return 0
  }
  for (const n of names) {
    const pr = store.providers[n]!
    if (isOauth(pr)) {
      console.log(`${c.bold(n.padEnd(14))} ${c.green('Claude subscription')}`)
      console.log(`  ${c.dim('own login in its profile directory — /login on first launch')}`)
      const s = inspectShim(paths, n)
      console.log(
        s.state === 'ours' ? `  ${c.dim('command')} ${c.green(n)}`
        : s.state === 'foreign' ? `  ${c.dim('command')} ${c.yellow(`\`${n}\` is taken by another program`)}`
        : `  ${c.dim(`no command — \`ccprovider install ${n}\``)}`,
      )
      continue
    }
    const hasKey = (await secrets.get(n)) != null
    const missing = missingSlots(pr)
    const flag = !hasKey ? c.red('no key') : missing.length ? c.yellow(`unmapped: ${missing.join(',')}`) : c.green('ready')
    console.log(`${c.bold(n.padEnd(14))} ${flag}`)
    console.log(`  ${c.dim(pr.baseUrl)}`)
    const shim = inspectShim(paths, n)
    console.log(
      shim.state === 'ours' ? `  ${c.dim('command')} ${c.green(n)}`
      : shim.state === 'foreign' ? `  ${c.dim('command')} ${c.yellow(`\`${n}\` is taken by another program`)}`
      : `  ${c.dim(`no command — \`ccprovider install ${n}\``)}`,
    )
    const a = pr.aliases
    const pair = (x?: string, y?: string) => (x === y ? (x ?? '—') : `${x ?? '—'} / ${y ?? '—'}`)
    const start = pr.defaultModel && pr.defaultModel !== a.opus ? ` · start ${pr.defaultModel}` : ''
    console.log(`  ${c.dim(`opus+sonnet ${pair(a.opus, a.sonnet)} · haiku+subagent ${pair(a.haiku, a.subagent)}${start}`)}`)
  }
  return 0
}

async function cmdUse(
  paths: ReturnType<typeof getPaths>,
  secrets: Awaited<ReturnType<typeof detectStore>>,
  name: string,
  model: string | null,
  passthrough: string[],
): Promise<number> {
  const store = loadStore(paths)
  const profile = getProfile(store, name)
  const oauth = isOauth(profile)
  const apiKey = oauth ? '' : await secrets.get(name)
  if (apiKey === null) {
    console.error(`No API key stored for "${name}". Run \`ccprovider edit ${name}\` to set one.`)
    return 1
  }
  if (!oauth && !apiKey) {
    console.error(`No API key stored for "${name}". Run \`ccprovider edit ${name}\` to set one.`)
    return 1
  }

  const missing = missingSlots(profile)
  if (missing.length) {
    console.error(
      c.yellow(`warning: "${name}" has no model mapped to: ${missing.join(', ')}.\n`) +
        c.dim(`  Sessions requesting those tiers will send a Claude model ID to your provider.\n` +
              `  Fix with \`ccprovider edit ${name}\`.\n`),
    )
  }

  const dir = profileDir(paths, name)
  const results = reconcileLinks(dir, paths.claudeDir)
  for (const r of results) {
    if (r.action === 'skipped-real') console.error(c.yellow(`warning: ${r.detail} — not shared with ~/.claude`))
  }

  const env = buildEnv({ profile, configDir: dir, apiKey, model, baseEnv: process.env })
  const claude = findClaude(env)
  const args = ['claude', ...passthrough]

  // Replace this process so signals, exit codes and the TTY behave exactly as if
  // the user had typed `claude` themselves.
  const execve = (process as unknown as { execve?: (f: string, a: string[], e: Record<string, string>) => never }).execve
  if (typeof execve === 'function') execve(claude, args, env)

  // Node < 24 has no execve; spawn in the same process group instead.
  const r = spawnSync(claude, passthrough, { stdio: 'inherit', env })
  if (r.error) {
    // e.g. claude was removed or lost the executable bit between `which` and spawn
    console.error(c.red(`Could not launch ${claude}: ${r.error.message}`))
    return 1
  }
  if (r.signal) process.kill(process.pid, r.signal)
  return r.status ?? 1
}

async function cmdRemove(
  paths: ReturnType<typeof getPaths>,
  secrets: Awaited<ReturnType<typeof detectStore>>,
  name: string,
  yes: boolean,
): Promise<number> {
  const store = loadStore(paths)
  getProfile(store, name)

  if (!yes) {
    const ok = await p.confirm({
      message: isOauth(getProfile(store, name))
        ? `Delete profile "${name}", its Claude login and its session history?`
        : `Delete profile "${name}", its API key and its session history?`,
      initialValue: false,
    })
    if (p.isCancel(ok) || !ok) { console.log('Cancelled.'); return 1 }
  }

  const r = await removeProfile({ paths, secrets, store }, name)
  for (const w of r.warnings) console.error(c.yellow(`! ${w}`))
  console.log(`Removed "${name}". Your ~/.claude is untouched.`)
  if (r.command === 'removed') console.log(`Removed the \`${name}\` command.`)
  else if (r.command === 'foreign') console.log(c.dim(`${join(paths.binDir, name)} is not a ccprovider launcher, so it was left alone.`))
  return 0
}

async function cmdDoctor(
  paths: ReturnType<typeof getPaths>,
  secrets: Awaited<ReturnType<typeof detectStore>>,
  name: string | undefined,
): Promise<number> {
  const store = loadStore(paths)
  const names = name ? [name] : Object.keys(store.providers)
  if (!names.length) { console.log('No profiles yet. Run `ccprovider add`.'); return 0 }

  let worst: 'ok' | 'warn' | 'fail' = 'ok'
  for (const n of names) {
    const profile = getProfile(store, n)
    console.log(`\n${c.bold(n)}  ${c.dim(isOauth(profile) ? 'Claude subscription' : profile.baseUrl)}`)
    const checks = await runDoctor(n, profile, paths, secrets)
    for (const check of checks) render(check)
    const s = worstStatus(checks)
    if (s === 'fail') worst = 'fail'
    else if (s === 'warn' && worst === 'ok') worst = 'warn'
  }

  // Launchers whose profile is gone belong to no profile's report, so they are checked
  // once, and only on a whole-install run.
  if (!name) {
    const orphans = orphanChecks(paths, names)
    if (orphans.length) {
      console.log(`\n${c.bold('leftover commands')}`)
      for (const check of orphans) render(check)
      if (worst === 'ok') worst = 'warn'
    }
  }
  return worst === 'fail' ? 1 : 0
}

function render(check: Check): void {
  const mark = check.status === 'ok' ? c.green('✓') : check.status === 'warn' ? c.yellow('!') : c.red('✗')
  console.log(`  ${mark} ${check.label}${check.detail ? c.dim(`  ${check.detail}`) : ''}`)
}

async function cmdEnv(
  paths: ReturnType<typeof getPaths>,
  secrets: Awaited<ReturnType<typeof detectStore>>,
  name: string,
): Promise<number> {
  const store = loadStore(paths)
  const profile = getProfile(store, name)
  const apiKey = isOauth(profile) ? '' : await secrets.get(name)
  if (apiKey === null || (!apiKey && !isOauth(profile))) { console.error(`No API key stored for "${name}".`); return 1 }
  const env = buildEnv({ profile, configDir: profileDir(paths, name), apiKey, model: null, baseEnv: {} })
  // Redacted when a human is looking; real values when piped into `eval`.
  const shown = process.stdout.isTTY ? describeEnv(env) : env
  for (const [k, v] of Object.entries(shown)) {
    console.log(`export ${k}=${shellQuote(v)}`)
  }
  if (process.stdout.isTTY) console.error(c.dim('\n# token redacted for display; pipe to `eval` for the real values'))
  return 0
}

/** package.json sits one directory up from both `dist/cli.js` (installed) and
 *  `src/cli.ts` (run from a clone), so this finds it either way. */
function version(): string {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return '0.0.0'
  }
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    if (err instanceof ProfileError || err instanceof LaunchError) {
      console.error(c.red(err.message))
      process.exit(1)
    }
    console.error(err)
    process.exit(1)
  })

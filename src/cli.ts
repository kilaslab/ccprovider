#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPaths, isInside, profileDir } from './paths.js'
import { loadStore, saveStore, getProfile, validateName, ProfileError } from './profile.js'
import { reconcileLinks, removeProfileDir } from './configdir.js'
import { AGENT_CATALOG, AGENT_SOURCE, installAgents, listInstalled, readExplore, removeAgents, setExplore, syncAgents, type AgentResult } from './agents.js'
import { buildEnv, describeEnv, findClaude, missingSlots, passThroughNotice, LaunchError } from './launch.js'
import { detectStore } from './secrets/index.js'
import { dotenvWarnings, formatEnv, parseEnvFormat, type EnvFormat } from './envformat.js'
import { addStatusline, compareVersions, inspectStatusline, removeStatusline, runOffer, STATUSLINE_SOURCE } from './statusline.js'
import { aggregate, ledgerPath, parseSince, prepareLedger, progressPercent, renderUsage, saveLedger, scanProfile, unreadableTotal, type Ledger } from './usage.js'
import { runDoctor, orphanChecks, defaultChecks, statuslineChecks, worstStatus, type Check } from './doctor.js'
import { claudeRunner, readInstalledMcp, resolveServers, resolveUnwanted, syncMcp } from './mcp.js'
import { findPreset } from './presets.js'
import { removeProfile } from './remove.js'
import { renameProfile } from './rename.js'
import { binDirOnPath, currentDefaultProfile, inspectDefaultShim, inspectShim, installCommandFor, installDefaultShim, listShims, removeDefaultShim, removeShim, selfLauncher, type DefaultShimStatus } from './shim.js'
import { p } from './tui/prompts.js'
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
  ${c.bold('ccprovider default')} [name]           make a profile the plain  claude  command (--off: put the real one back)
  ${c.bold('ccprovider doctor')} [name]            check a profile end to end
  ${c.bold('ccprovider usage')} [name]             tokens used per model: input, output and cache
  ${c.bold('ccprovider statusline')} [add|rm]      show context use in Claude Code's footer (one install covers every profile)
  ${c.bold('ccprovider env')} <name> [--format f]  print the variables it would set (sh, dotenv or json)
  ${c.bold('ccprovider agents')} <name>            list a profile's agents and its Explore model
  ${c.bold('ccprovider agents add')} <name> [id…]  install agents (no IDs: pick from the list)
  ${c.bold('ccprovider agents rm')} <name> <id…>   remove agents (-y also removes ones you edited)
  ${c.bold('ccprovider agents explore')} <name> <haiku|sonnet|opus|model-id|default>
                                      choose the model the Explore subagent runs on

Options
  -m, --model <tier|id>   opus | sonnet | haiku | opusplan | a provider model ID
  --format <sh|dotenv|json>
                          with env: export lines (default), a Docker --env-file, or an
                          object for the Agent SDK's env option. dotenv and json leave
                          out CLAUDE_CONFIG_DIR, which is a path on this machine
  --refresh               re-fetch the provider's model list
  --no-install            with add: do not install the profile as a command
  --no-statusline         with add: do not offer the token footer
  --off                   with default: stop overriding  claude
  --since <7d|YYYY-MM-DD> with usage: only calls from then on
  --by day                with usage: one row per day
  --json                  with usage: exact figures, for scripts
  --rebuild               with usage: forget the ledger and read the transcripts again
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
      format: { type: 'string' },
      off: { type: 'boolean', default: false },
      since: { type: 'string' },
      by: { type: 'string' },
      json: { type: 'boolean', default: false },
      rebuild: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
      // Declared by its full name: parseArgs's `allowNegative` needs a newer Node than
      // this tool's floor, and the flag is only ever meant negatively.
      'no-install': { type: 'boolean', default: false },
      'no-statusline': { type: 'boolean', default: false },
      // Written into the default wrapper, not typed: see cmdUse.
      'from-default': { type: 'boolean', default: false },
    },
  })

  const [cmd, name, name2] = positionals
  if (values.version) { console.log(version()); return 0 }
  if (values.help || !cmd || cmd === 'help') { console.log(USAGE); return cmd || values.help ? 0 : 1 }

  // An option that belongs to one command is refused on the others. Ignored without a word,
  // `usage --format json` printed the table with exit 0, and a script piped it to jq.
  const OWNED: Record<string, string> = { format: 'env', since: 'usage', by: 'usage', json: 'usage', rebuild: 'usage', off: 'default', 'no-statusline': 'add', 'from-default': 'use' }
  for (const [flag, owner] of Object.entries(OWNED)) {
    const given = (values as Record<string, unknown>)[flag]
    if (given !== undefined && given !== false && cmd !== owner) {
      console.error(`--${flag} only applies to \`ccprovider ${owner}\`, not to \`ccprovider ${cmd}\`.`)
      return 1
    }
  }

  const paths = getPaths()
  const secrets = await detectStore()

  switch (cmd) {
    case 'add': return cmdAdd(paths, secrets, values.refresh, !values['no-install'], !values['no-statusline'])
    case 'ls': case 'list': return cmdList(paths, secrets)
    case 'use': return cmdUse(paths, secrets, requireName(name, 'use'), values.model ?? null, passthrough, values['from-default'])
    case 'edit': return cmdEdit(paths, secrets, requireName(name, 'edit'), values.refresh)
    case 'rename': case 'mv': return cmdRename(paths, secrets, requireName(name, 'rename'), requireName(name2, 'rename', 'the new name'), values.yes)
    case 'rm': case 'remove': case 'delete': return cmdRemove(paths, secrets, requireName(name, 'rm'), values.yes)
    case 'install': return cmdInstall(paths, name ? validateName(name) : undefined)
    case 'uninstall': return cmdUninstall(paths, name ? validateName(name) : undefined, values.yes)
    case 'default': return cmdDefault(paths, name ? validateName(name) : undefined, values.off)
    case 'statusline': return cmdStatusline(paths, name)
    case 'usage': return cmdUsage(paths, name ? validateName(name) : undefined, { since: values.since, by: values.by, json: values.json, rebuild: values.rebuild })
    case 'doctor': return cmdDoctor(paths, secrets, name ? validateName(name) : undefined)
    case 'env': return cmdEnv(paths, secrets, requireName(name, 'env'), parseEnvFormat(values.format))
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
    claude = findClaude(process.env, [paths.defaultBinDir])
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

async function cmdAdd(paths: Paths, secrets: Secrets, refresh: boolean, install: boolean, statusline: boolean): Promise<number> {
  const store = loadStore(paths)
  const { runWizard } = await import('./tui/wizard.js')
  const result = await runWizard(paths, null, Object.keys(store.providers), refresh)
  if ('editInstead' in result) return cmdEdit(paths, secrets, result.editInstead, refresh)
  // Deleted only now that the new one is confirmed: cancelling anywhere before this
  // leaves the old profile exactly as it was.
  if (result.replace) {
    const r = await removeProfile({ paths, secrets, store }, result.name, { keepDefault: true })
    for (const w of r.warnings) console.error(c.yellow(`! ${w}`))
    console.log(c.dim(`Replaced the previous "${result.name}" profile, its session history and its usage record.`))
  }
  store.providers[result.name] = result.profile
  saveStore(paths, store)
  if (result.apiKey) await secrets.set(result.name, result.apiKey)
  const dir = profileDir(paths, result.name)
  reconcileLinks(dir, paths.claudeDir)

  for (const line of setupMcp(paths, result.name, result.profile, [])) console.log(line)
  for (const line of await setupAgents(paths, result.name, result.agents, result.explore)) console.log(line)
  for (const line of await offerStatusline(paths, statusline)) console.log(line)
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

/** What is still between the user and the wrapper. Like `pathHint`, it is about a directory
 *  and not for one command, and it only ever prints: nothing here edits a shell profile. */
function defaultPathHint(paths: Paths, s: DefaultShimStatus): string[] {
  if (s.dirOnPath && !s.shadowedBy) return []
  const why = s.shadowedBy
    ? `Typing \`claude\` still runs ${s.shadowedBy}.`
    : `${paths.defaultBinDir} is not on your PATH, so typing \`claude\` does not reach it yet.`
  return [
    c.yellow(`  ! ${why}`),
    c.dim(`    Put the directory before it:  export PATH="${paths.defaultBinDir}:$PATH"   (add it to your shell profile)`),
  ]
}

async function cmdDefault(paths: Paths, name: string | undefined, off: boolean): Promise<number> {
  if (name && off) {
    console.error('Give a profile or --off, not both.')
    return 1
  }

  if (off) {
    const r = removeDefaultShim(paths)
    if (r === 'removed') console.log('`claude` runs Claude Code as installed again.')
    else if (r === 'absent') console.log('No default profile is set.')
    else console.error(`${join(paths.defaultBinDir, 'claude')} is not a ccprovider wrapper, so it was left alone.`)
    return r === 'foreign' ? 1 : 0
  }

  if (!name) {
    const s = inspectDefaultShim(paths)
    if (s.state === 'absent') {
      console.log('No default profile. `claude` runs Claude Code as installed; `ccprovider default <profile>` changes that.')
      return 0
    }
    if (s.state === 'foreign') {
      console.error(c.yellow(`! ${s.path} is not a ccprovider wrapper, so \`ccprovider default\` leaves it alone.`))
      return 1
    }
    console.log(`\`claude\` runs the "${s.profile}" profile  ${c.dim(s.path)}`)
    if (!s.targetOk) {
      console.log(c.yellow(`  ! The wrapper points at ${s.launcher!.join(' ')}, which is missing or not executable. Run \`ccprovider default ${s.profile}\` again.`))
    }
    if (!Object.hasOwn(loadStore(paths).providers, s.profile!)) {
      console.log(c.yellow(`  ! There is no "${s.profile}" profile any more. \`ccprovider default --off\` removes the wrapper.`))
    }
    for (const line of defaultPathHint(paths, s)) console.log(line)
    return 0
  }

  getProfile(loadStore(paths), name)
  const r = installDefaultShim(paths, name, selfLauncher())
  console.log(`${c.green('✓')} \`claude\` now runs the "${name}" profile  ${c.dim(r.path)}${r.action === 'unchanged' ? c.dim('  (it already did)') : ''}`)
  for (const line of defaultPathHint(paths, inspectDefaultShim(paths))) console.log(line)
  return 0
}

/** The token footer is install-wide: statusLine lives in settings.json, which every profile
 *  links to. So it is offered once, on `add`, and a "no" is remembered. */
async function offerStatusline(paths: Paths, enabled: boolean): Promise<string[]> {
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

async function cmdStatusline(paths: Paths, sub: string | undefined): Promise<number> {
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

interface UsageFlags {
  since?: string
  by?: string
  json: boolean
  rebuild: boolean
}

const mb = (bytes: number) => (bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)} GB` : `${Math.round(bytes / (1 << 20))} MB`)

async function cmdUsage(paths: Paths, name: string | undefined, flags: UsageFlags): Promise<number> {
  const store = loadStore(paths)
  if (name) getProfile(store, name)
  const names = name ? [name] : Object.keys(store.providers)
  if (!names.length) { console.log('No profiles yet. Run `ccprovider add`.'); return 0 }

  // Checked before reading gigabytes, not after.
  const since = flags.since === undefined ? undefined : parseSince(flags.since)
  if (flags.by !== undefined && flags.by !== 'day') throw new ProfileError(`--by takes "day", not "${flags.by}".`)

  // Only worth a progress line when there is a lot to read and a person watching.
  const watched = process.stdout.isTTY && !flags.json
  const ledgers: Record<string, Ledger> = {}
  let unreadable = 0
  let skipped = 0

  for (const n of names) {
    const path = ledgerPath(paths, n)
    // What guards the history in the ledger (set aside what cannot be read, keep the backup
    // that holds more) is decided in usage.ts, where it is tested.
    const { ledger, notes, readOnly } = prepareLedger(paths, n, { rebuild: flags.rebuild })
    for (const note of notes) console.error(note.warn ? c.yellow(`! ${note.text}`) : c.dim(note.text))
    const save = () => {
      if (readOnly) return // a ledger from a newer ccprovider is not ours to write
      // Also when no call was found: the positions in the transcripts that were read are worth keeping.
      if (Object.keys(ledger.files).length || Object.keys(ledger.calls).length || existsSync(path)) saveLedger(path, ledger)
    }

    const ui: { spin: ReturnType<typeof p.spinner> | null } = { spin: null }
    let lastTick = 0
    let r: Awaited<ReturnType<typeof scanProfile>> | undefined
    try {
      r = await scanProfile(profileDir(paths, n), ledger, {
        onProgress: (done, total) => {
          if (!watched || total < 32 << 20) return
          if (!ui.spin) { ui.spin = p.spinner(); ui.spin.start(`Reading ${n}'s transcripts`) }
          const now = Date.now()
          if (now - lastTick < 200) return
          lastTick = now
          ui.spin.message(`Reading ${n}'s transcripts: ${progressPercent(done, total)}% of ${mb(total)}`)
        },
        // A scan of gigabytes that is interrupted keeps what it has read.
        onCheckpoint: save,
      })
    } finally {
      // Also when the scan or a checkpoint throws: a spinner left running garbles the error.
      ui.spin?.stop(r ? `Read ${mb(r.bytesRead)} of ${n}'s transcripts` : `Stopped reading ${n}'s transcripts`)
    }
    if (r.filesRead > 0 || flags.rebuild) save()
    unreadable += unreadableTotal(ledger)
    skipped += r.skippedFiles
    ledgers[n] = ledger
  }

  const rows = aggregate(ledgers, { since, by: flags.by === 'day' ? 'day' : undefined })
  if (flags.json) {
    console.log(JSON.stringify({ rows, unreadableLines: unreadable, skippedFiles: skipped }, null, 2))
    return 0
  }

  // Colour for a person at a terminal, not for a file or a pager, and not against NO_COLOR.
  const color = !!process.stdout.isTTY && !process.env.NO_COLOR
  const dim = (text: string) => (color ? c.dim(text) : text)
  const subscription = new Set(names.filter((n) => isOauth(store.providers[n]!)))
  console.log(renderUsage(rows, { subscription, color }))
  if (rows.length) {
    console.log(dim('\nFrom the transcripts Claude Code keeps in each profile, not the provider\'s bill. A dash means the provider did not report cache.'))
  }
  if (skipped) console.log(dim(`${skipped} transcript${skipped === 1 ? '' : 's'} could not be opened (deleted or locked meanwhile) and will be tried again next time.`))
  if (unreadable) console.log(dim(`${unreadable} line${unreadable === 1 ? '' : 's'} that looked like a call could not be read and were skipped.`))
  return 0
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
  fromDefault = false,
): Promise<number> {
  // The default wrapper, run from inside a session ccprovider started (a hook, a subagent's
  // shell): this is a `claude` inside a session that already has its provider, and moving it
  // to the default profile would send its requests to another provider with another bill.
  // Pass it through to the real claude with the environment it already has. PATH is left alone.
  if (fromDefault && process.env.CCPROVIDER_SESSION) {
    const notice = passThroughNotice(!!process.stderr.isTTY)
    if (notice) console.error(c.dim(notice))
    return launchClaude(findClaude(process.env, [paths.defaultBinDir]), passthrough, definedEnv(process.env))
  }

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
  // Marks the session, so a default wrapper run inside it knows it is inside one.
  env.CCPROVIDER_SESSION = '1'
  return launchClaude(findClaude(env, [paths.defaultBinDir]), passthrough, env)
}

/** The environment as `execve` wants it: strings only. */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === 'string'))
}

function launchClaude(claude: string, passthrough: string[], env: Record<string, string>): number {
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
  if (r.defaultCommand === 'removed') console.log(`Removed the default \`claude\` command too: \`claude\` runs Claude Code as installed again.`)
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
  // Not an early return: what belongs to the install and not to a profile (the default
  // `claude`, the footer, leftover commands) can be broken with no profile left at all.
  if (!names.length) console.log('No profiles yet. Run `ccprovider add`.')

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

async function cmdEnv(
  paths: ReturnType<typeof getPaths>,
  secrets: Awaited<ReturnType<typeof detectStore>>,
  name: string,
  format: EnvFormat,
): Promise<number> {
  const store = loadStore(paths)
  const profile = getProfile(store, name)
  // The other formats are for something that is not this machine, and a subscription
  // profile has nothing to hand it: only a config dir, and that is left out.
  if (isOauth(profile) && format !== 'sh') {
    throw new ProfileError(`"${name}" is a Claude subscription profile: it has no provider variables to export. Its login lives in ${profileDir(paths, name)}.`)
  }
  const apiKey = isOauth(profile) ? '' : await secrets.get(name)
  if (apiKey === null || (!apiKey && !isOauth(profile))) { console.error(`No API key stored for "${name}".`); return 1 }
  const env = buildEnv({ profile, configDir: profileDir(paths, name), apiKey, model: null, baseEnv: {} })
  // Redacted when a human is looking; real values when piped into `eval` or a file.
  const shown = process.stdout.isTTY ? describeEnv(env) : env
  process.stdout.write(formatEnv(shown, format))
  if (format === 'dotenv') {
    const risky = dotenvWarnings(env)
    if (risky.length) {
      console.error(c.yellow(`! ${risky.join(', ')} ${risky.length === 1 ? 'has' : 'have'} a value that docker compose's env_file or python-dotenv would change (spaces at the ends, quotes, \`$\` or \` #\`).`))
      console.error(c.dim('  `docker run --env-file` reads them as they are. For anything else, use --format json.'))
    }
  }
  if (process.stdout.isTTY) {
    console.error(c.dim(`\n# token redacted for display; ${format === 'sh' ? 'pipe to `eval`' : 'pipe or redirect it'} for the real values`))
  }
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

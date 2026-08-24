#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { spawnSync } from 'node:child_process'

import { getPaths, profileDir } from './paths.js'
import { loadStore, saveStore, getProfile, validateName, ProfileError } from './profile.js'
import { reconcileLinks, removeProfileDir } from './configdir.js'
import { buildEnv, describeEnv, findClaude, missingSlots, LaunchError } from './launch.js'
import { detectStore } from './secrets/index.js'
import { runDoctor, worstStatus, type Check } from './doctor.js'
import { p } from './tui/prompts.js'
import { shellQuote } from './shell.js'

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
  ${c.bold('ccprovider rm')} <name>                delete a profile and its key
  ${c.bold('ccprovider doctor')} [name]            check a profile end to end
  ${c.bold('ccprovider env')} <name>               print the exports it would set

Options
  -m, --model <tier|id>   opus | sonnet | haiku | a provider model ID
  --refresh               re-fetch the provider's model list
  -y, --yes               skip confirmation prompts
  -h, --help              this text

Anything after ${c.bold('--')} is passed straight to claude:
  ccprovider use deepseek -- --resume
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
    },
  })

  const [cmd, name] = positionals
  if (values.version) { console.log(await version()); return 0 }
  if (values.help || !cmd || cmd === 'help') { console.log(USAGE); return cmd || values.help ? 0 : 1 }

  const paths = getPaths()
  const secrets = await detectStore()

  switch (cmd) {
    case 'add': return cmdAdd(paths, secrets, values.refresh)
    case 'ls': case 'list': return cmdList(paths, secrets)
    case 'use': return cmdUse(paths, secrets, requireName(name, 'use'), values.model ?? null, passthrough)
    case 'edit': return cmdEdit(paths, secrets, requireName(name, 'edit'), values.refresh)
    case 'rm': case 'remove': return cmdRemove(paths, secrets, requireName(name, 'rm'), values.yes)
    case 'doctor': return cmdDoctor(paths, secrets, name ? validateName(name) : undefined)
    case 'env': return cmdEnv(paths, secrets, requireName(name, 'env'))
    default:
      console.error(`Unknown command "${cmd}".\n`)
      console.log(USAGE)
      return 1
  }
}

function requireName(name: string | undefined, cmd: string): string {
  if (!name) {
    console.error(`\`ccprovider ${cmd}\` needs a profile name. Run \`ccprovider ls\` to see them.`)
    process.exit(1)
  }
  // Normalised here so every downstream use — store lookup, profile dir, keychain
  // account — agrees on one spelling.
  return validateName(name)
}

async function cmdAdd(paths: ReturnType<typeof getPaths>, secrets: Awaited<ReturnType<typeof detectStore>>, refresh: boolean): Promise<number> {
  const store = loadStore(paths)
  const { runWizard } = await import('./tui/wizard.js')
  const result = await runWizard(paths, null, Object.keys(store.providers), refresh)
  store.providers[result.name] = result.profile
  saveStore(paths, store)
  await secrets.set(result.name, result.apiKey)
  const dir = profileDir(paths, result.name)
  reconcileLinks(dir, paths.claudeDir)
  p.outro(`Saved. Launch it with  ${c.bold(`ccprovider use ${result.name}`)}`)
  return 0
}

async function cmdEdit(paths: ReturnType<typeof getPaths>, secrets: Awaited<ReturnType<typeof detectStore>>, name: string, refresh: boolean): Promise<number> {
  const store = loadStore(paths)
  const profile = getProfile(store, name)
  const apiKey = await secrets.get(name)
  const { runWizard } = await import('./tui/wizard.js')
  const result = await runWizard(paths, { name, profile, apiKey }, [], refresh)
  store.providers[name] = result.profile
  saveStore(paths, store)
  await secrets.set(name, result.apiKey)
  reconcileLinks(profileDir(paths, name), paths.claudeDir)
  p.outro('Updated.')
  return 0
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
    const hasKey = (await secrets.get(n)) != null
    const missing = missingSlots(pr)
    const flag = !hasKey ? c.red('no key') : missing.length ? c.yellow(`unmapped: ${missing.join(',')}`) : c.green('ready')
    console.log(`${c.bold(n.padEnd(14))} ${flag}`)
    console.log(`  ${c.dim(pr.baseUrl)}`)
    const a = pr.aliases
    const pair = (x?: string, y?: string) => (x === y ? (x ?? '—') : `${x ?? '—'} / ${y ?? '—'}`)
    console.log(`  ${c.dim(`opus+sonnet ${pair(a.opus, a.sonnet)} · haiku+subagent ${pair(a.haiku, a.subagent)}`)}`)
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
  const apiKey = await secrets.get(name)
  if (!apiKey) {
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
  const dir = profileDir(paths, name)

  if (!yes) {
    const ok = await p.confirm({
      message: `Delete profile "${name}", its API key and its session history?`,
      initialValue: false,
    })
    if (p.isCancel(ok) || !ok) { console.log('Cancelled.'); return 1 }
  }

  removeProfileDir(dir, paths.dirsRoot)
  await secrets.delete(name)
  delete store.providers[name]
  saveStore(paths, store)
  console.log(`Removed "${name}". Your ~/.claude is untouched.`)
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
    console.log(`\n${c.bold(n)}  ${c.dim(profile.baseUrl)}`)
    const checks = await runDoctor(n, profile, paths, secrets)
    for (const check of checks) render(check)
    const s = worstStatus(checks)
    if (s === 'fail') worst = 'fail'
    else if (s === 'warn' && worst === 'ok') worst = 'warn'
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
  const apiKey = await secrets.get(name)
  if (!apiKey) { console.error(`No API key stored for "${name}".`); return 1 }
  const env = buildEnv({ profile, configDir: profileDir(paths, name), apiKey, model: null, baseEnv: {} })
  // Redacted when a human is looking; real values when piped into `eval`.
  const shown = process.stdout.isTTY ? describeEnv(env) : env
  for (const [k, v] of Object.entries(shown)) {
    console.log(`export ${k}=${shellQuote(v)}`)
  }
  if (process.stdout.isTTY) console.error(c.dim('\n# token redacted for display; pipe to `eval` for the real values'))
  return 0
}

async function version(): Promise<string> {
  try {
    const { readFileSync } = await import('node:fs')
    const url = new URL('../package.json', import.meta.url)
    return JSON.parse(readFileSync(url, 'utf8')).version
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

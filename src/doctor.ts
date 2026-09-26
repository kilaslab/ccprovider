import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from './paths.js'
import { profileDir } from './paths.js'
import type { Profile, AliasSlot } from './types.js'
import { inspectLinks, LINKED_ENTRIES } from './configdir.js'
import { missingSlots, SLOT_ENV, findClaude, MANAGED_VARS, STRIPPED_VARS } from './launch.js'
import { compareInstalled, HELPER_KEY_RE, readInstalledMcp, registeredIds, resolveServers } from './mcp.js'
import { findPreset } from './presets.js'
import { probeEndpoint, probeModel } from './probe.js'
import type { SecretStore } from './secrets/index.js'
import { inspectShim, listShims } from './shim.js'

export type Status = 'ok' | 'warn' | 'fail'
export interface Check {
  label: string
  status: Status
  detail?: string
}

export interface Runtime {
  /** Version of the `node` on PATH, or null if there is none. */
  node: string | null
  npx: boolean
}

export interface DoctorOpts {
  skipNetwork?: boolean
  fetchImpl?: typeof fetch
  /** Environment to resolve PATH from. */
  env?: Record<string, string | undefined>
  /** What `npx`-based MCP servers will find. Injectable; the default asks the shell. */
  runtime?: Runtime
}

export async function runDoctor(
  name: string,
  profile: Profile,
  paths: Paths,
  secrets: SecretStore,
  opts: DoctorOpts = {},
): Promise<Check[]> {
  const checks: Check[] = []
  const dir = profileDir(paths, name)

  // --- claude binary
  try {
    checks.push({ label: 'claude on PATH', status: 'ok', detail: findClaude(process.env as Record<string, string>) })
  } catch (e) {
    checks.push({ label: 'claude on PATH', status: 'fail', detail: (e as Error).message })
  }

  // --- profile directory and links
  if (!existsSync(dir)) {
    checks.push({ label: 'profile directory', status: 'warn', detail: `${dir} not created yet (next \`use\` will create it)` })
  } else {
    const rows = inspectLinks(dir)
    const broken = rows.filter((r) => r.broken)
    const real = rows.filter((r) => r.target === '(real file, not linked)')
    const linked = rows.filter((r) => r.target && !r.broken && r.target !== '(real file, not linked)')
    checks.push({
      label: 'shared config links',
      status: broken.length ? 'fail' : real.length ? 'warn' : 'ok',
      detail:
        broken.length ? `broken: ${broken.map((r) => r.entry).join(', ')}`
        : real.length ? `not shared (real files): ${real.map((r) => r.entry).join(', ')}`
        : `${linked.length}/${LINKED_ENTRIES.length} linked to ${paths.claudeDir}`,
    })
  }

  // --- alias coverage: the check that catches silent 404s
  const missing = missingSlots(profile)
  checks.push({
    label: 'model tier mapping',
    status: missing.length ? 'fail' : 'ok',
    detail: missing.length
      ? `unmapped: ${missing.join(', ')} — sessions requesting these send a Claude model ID to your provider`
      : 'opus, sonnet, haiku and subagent all mapped',
  })

  // --- credential
  const key = await secrets.get(name)
  checks.push({
    label: `API key (${secrets.name})`,
    status: key ? 'ok' : 'fail',
    detail: key ? 'present' : `no key stored for "${name}" — run \`ccprovider edit ${name}\``,
  })

  // --- the command, the shared settings that can silently override us, and MCP
  const env = opts.env ?? process.env
  checks.push(commandCheck(name, paths, env))
  const settings = settingsCheck(dir)
  if (settings) checks.push(settings)
  checks.push(...mcpChecks(name, profile, dir, key, opts.runtime))

  if (opts.skipNetwork || !key) return checks

  // --- endpoint
  const verdict = await probeEndpoint(profile.baseUrl, opts.fetchImpl)
  checks.push({
    label: 'endpoint format',
    status: verdict.kind === 'anthropic' ? 'ok' : 'fail',
    detail:
      verdict.kind === 'anthropic' ? `${profile.baseUrl} speaks Anthropic Messages`
      : verdict.kind === 'openai-only' ? 'OpenAI format — needs a LiteLLM front (see `ccprovider add`)'
      : verdict.kind === 'unreachable' ? `unreachable: ${verdict.detail}`
      : `unexpected HTTP ${verdict.status}`,
  })

  // --- every alias slot, for real
  const slots = Object.keys(SLOT_ENV) as AliasSlot[]
  const probes = await Promise.all(
    slots
      .filter((s) => profile.aliases[s])
      .map(async (slot) => ({ slot, model: profile.aliases[slot]!, result: await probeModel(profile.baseUrl, key, profile.aliases[slot]!, opts.fetchImpl) })),
  )
  for (const { slot, model, result } of probes) {
    checks.push({
      label: `  ${slot} -> ${model}`,
      status: result.ok ? 'ok' : 'fail',
      detail: result.ok ? 'resolves' : (result.error ?? `HTTP ${result.status}`),
    })
  }

  return checks
}

/** Does typing `<name>` in a shell run this profile? */
function commandCheck(name: string, paths: Paths, env: Record<string, string | undefined>): Check {
  const label = `command \`${name}\``
  const s = inspectShim(paths, name, env)

  if (s.state === 'absent') {
    return { label, status: 'warn', detail: `not installed — run \`ccprovider install ${name}\` to launch this profile as \`${name}\`` }
  }
  if (s.state === 'foreign') {
    return { label, status: 'warn', detail: `${s.path} is not a ccprovider launcher, so \`${name}\` runs something else` }
  }
  if (!s.targetOk) {
    return {
      label,
      status: 'fail',
      detail: `launcher points at ${s.launcher!.join(' ')}, which is missing or not executable — re-run \`ccprovider install ${name}\``,
    }
  }
  if (!s.binDirOnPath) {
    return { label, status: 'warn', detail: `installed, but ${paths.binDir} is not on PATH — add it to your shell's PATH to use \`${name}\`` }
  }
  if (s.shadowedBy) {
    return { label, status: 'warn', detail: `installed, but \`${name}\` resolves to ${s.shadowedBy} first` }
  }
  return { label, status: 'ok', detail: s.path }
}

/** Variables `ccprovider use` is responsible for — the same lists `buildEnv` clears and
 *  sets, so this cannot drift from what the launcher actually manages. `CLAUDE_CONFIG_DIR`
 *  is the profile's own directory, and nothing in a settings file can usefully move it. */
const OWNED_ENV = new Set<string>([...MANAGED_VARS, ...STRIPPED_VARS].filter((v) => v !== 'CLAUDE_CONFIG_DIR'))

/** The ones that decide *where a request goes and who it is sent as*. A settings file
 *  overriding these sends a profile's traffic (or another provider's key) somewhere else
 *  entirely, so it is a failure. The rest — context size, compaction, effort — quietly
 *  defeat the profile's tuning: wrong, but not a misdirected request. */
const ROUTING_ENV = /^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_SUBAGENT_MODEL$)/

/**
 * The shared `settings.json` is linked into every profile, and its `env` block wins over
 * the environment `ccprovider use` builds (measured on Claude Code 2.1.283: with the
 * same variable set in both, the settings value is the one sent). Z.ai's coding-helper
 * writes `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` there, which would point every
 * profile at Z.ai; a stray `CLAUDE_CODE_AUTO_COMPACT_WINDOW` would undo the profile's
 * context-window setting the same way.
 */
function settingsCheck(dir: string): Check | null {
  const file = join(dir, 'settings.json')
  let env: unknown
  try {
    env = (JSON.parse(readFileSync(file, 'utf8')) as { env?: unknown }).env
  } catch {
    return null // no settings file, or not ours to judge
  }
  const keys = typeof env === 'object' && env !== null ? Object.keys(env).filter((k) => OWNED_ENV.has(k)) : []
  const label = 'settings.json overrides'
  if (!keys.length) return { label, status: 'ok', detail: 'sets none of the variables ccprovider manages' }

  let real = file
  try { real = realpathSync(file) } catch { /* keep the profile path */ }
  return {
    label,
    status: keys.some((k) => ROUTING_ENV.test(k)) ? 'fail' : 'warn',
    detail: `${real} sets ${keys.join(', ')}, which Claude Code applies over this profile's own values — remove them there`,
  }
}

function mcpChecks(name: string, profile: Profile, dir: string, key: string | null, runtime?: Runtime): Check[] {
  const preset = profile.preset ? findPreset(profile.preset) : undefined
  if (!preset?.mcp) return []

  // The endpoint comes first: everything else assumes a host the servers may talk to.
  const installed = readInstalledMcp(dir)
  const { region, servers, unknown } = resolveServers(profile, preset)
  const hosts = preset.mcp.regions.map((r) => r.origin).join(', ')
  if (!region) {
    // A server registered for a host this profile no longer talks to is not merely stale:
    // its header helper sends the profile's key to that host.
    const stranded = registeredIds(installed, preset).map<Check>((id) => ({
      label: `MCP ${id}`,
      status: 'fail',
      detail:
        `still registered, but this profile's endpoint (${profile.baseUrl}) is not one of ${hosts}, ` +
        `so the server would be sent this profile's key — run \`ccprovider edit ${name}\` to remove it`,
    }))
    if (!stranded.length && profile.mcp?.length) {
      stranded.push({ label: 'MCP tools', status: 'warn', detail: `${profile.baseUrl} is not one of ${hosts}, so none are installed` })
    }
    return stranded
  }

  if (profile.mcp === undefined) {
    return [{ label: 'MCP tools', status: 'warn', detail: `not chosen yet — run \`ccprovider edit ${name}\` to enable ${preset.label}'s servers` }]
  }
  if (!profile.mcp.length) return []

  const checks: Check[] = []
  for (const want of servers) {
    const state = compareInstalled(installed, want)
    checks.push({
      label: `MCP ${want.spec.id}`,
      status: state === 'ok' ? 'ok' : 'warn',
      detail:
        state === 'ok' ? want.spec.label
        : state === 'missing' ? `not registered in this profile — run \`ccprovider edit ${name}\``
        : `differs from what ccprovider would write — run \`ccprovider edit ${name}\` to reset it`,
    })
  }
  for (const id of unknown) {
    checks.push({ label: `MCP ${id}`, status: 'warn', detail: `${preset.label} no longer defines this server — run \`ccprovider edit ${name}\` to drop it` })
  }

  // The header helper refuses keys outside a plain token alphabet (it splices the value
  // into JSON). Such a key still passes every other check, so say it here.
  if (key && servers.some((s) => s.spec.kind === 'http') && !HELPER_KEY_RE.test(key)) {
    checks.push({
      label: 'MCP key format',
      status: 'warn',
      detail: `the stored key has characters the MCP header helper refuses (it accepts letters, digits and . _ ~ + / = -), so the web servers would answer 401 — re-enter it with \`ccprovider edit ${name}\``,
    })
  }

  // stdio servers are launched with `npx`; Z.ai's docs require Node 22 for theirs.
  if (servers.some((s) => s.spec.kind === 'stdio')) {
    const rt = runtime ?? probeRuntime()
    const major = rt.node ? Number(rt.node.split('.')[0]) : NaN
    checks.push({
      label: 'MCP runtime (npx)',
      status: !rt.npx || !(major >= 22) ? 'warn' : 'ok',
      detail:
        !rt.npx ? '`npx` is not on PATH, so the stdio server cannot start'
        : !(major >= 22) ? `node ${rt.node ?? '(none)'} found; the vision server's docs require Node 22 or newer`
        : `node ${rt.node}`,
    })
  }
  return checks
}

// Asked once per process: each probe can take up to its timeout, and a whole-install
// `doctor` would otherwise repeat the same two questions for every profile.
let runtimeMemo: Runtime | undefined

function probeRuntime(): Runtime {
  if (runtimeMemo) return runtimeMemo
  const run = (cmd: string, args: string[]) => {
    try {
      return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()
    } catch {
      return null
    }
  }
  runtimeMemo = { node: run('node', ['-p', 'process.versions.node']), npx: run('npx', ['--version']) !== null }
  return runtimeMemo
}

/** Launchers whose profile has been deleted — reported once, not per profile. */
export function orphanChecks(paths: Paths, knownProfiles: string[]): Check[] {
  return listShims(paths)
    .filter((s) => !knownProfiles.includes(s.profile))
    .map((s) => ({
      label: `command \`${s.command}\``,
      status: 'warn' as const,
      detail: `${s.path} launches profile "${s.profile}", which no longer exists — run \`ccprovider uninstall ${s.command}\``,
    }))
}

export function worstStatus(checks: Check[]): Status {
  if (checks.some((c) => c.status === 'fail')) return 'fail'
  if (checks.some((c) => c.status === 'warn')) return 'warn'
  return 'ok'
}

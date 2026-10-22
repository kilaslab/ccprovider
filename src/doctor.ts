import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Paths } from './paths.js'
import { profileDir } from './paths.js'
import { relative, sep } from 'node:path'
import { isClaudeToken, isOauth, looksLikeSetupToken, type Profile, type AliasSlot } from './types.js'
import { listInstalled, readExplore } from './agents.js'
import { inspectLinks, LINKED_ENTRIES } from './configdir.js'
import { missingSlots, SLOT_ENV, findClaude, MANAGED_VARS, PROVIDER_VARS, STRIPPED_VARS } from './launch.js'
import { compareInstalled, HELPER_KEY_RE, readInstalledMcp, registeredIds, resolveServers } from './mcp.js'
import { DEFAULT_SLOT } from './defaultslot.js'
import { findPreset } from './presets.js'
import { probeEndpoint, probeModel } from './probe.js'
import type { SecretStore } from './secrets/index.js'
import { currentDefaultProfile, inspectDefaultShim, inspectShim, listShims } from './shim.js'
import { loadSlot, slotFilePath, variantAccount } from './slot.js'
import { compareVersions, inspectStatusline, STATUSLINE_SOURCE } from './statusline.js'

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
  /** The profile runs its sessions in the real config dir (see settings.ts): there are no
   *  links of its own to check, and its agents and MCP have nowhere of their own to live. */
  shared?: boolean
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
    checks.push({ label: 'claude on PATH', status: 'ok', detail: findClaude(process.env, [paths.defaultBinDir]) })
  } catch (e) {
    checks.push({ label: 'claude on PATH', status: 'fail', detail: (e as Error).message })
  }

  // --- profile directory and links
  if (opts.shared) {
    checks.push({
      label: 'config directory',
      status: 'ok',
      detail: `shared with ${paths.claudeDir} — sessions and todos${isClaudeToken(profile) ? '' : ', and credentials,'} are the plain claude's`,
    })
  } else if (!existsSync(dir)) {
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

  // A subscription profile has no endpoint, key or aliases to check; what matters is
  // whether it has signed in yet, plus the command and the shared-settings override.
  if (profile.kind === 'oauth') {
    const signedIn = existsSync(join(dir, '.credentials.json'))
    checks.push({
      label: 'Claude login',
      // macOS keeps the login in the Keychain, so a missing file proves nothing there.
      status: 'ok',
      detail: signedIn
        ? 'credentials found in the profile directory'
        : `not detected in the profile directory (on macOS it may be in the Keychain) — run \`${name}\` and use /login if it asks`,
    })
    checks.push(commandCheck(name, paths, opts.env ?? process.env))
    const s = settingsCheck(opts.shared ? paths.claudeDir : dir, OWNED_ENV)
    if (s) checks.push(s)
    if (!opts.shared) {
      const a = agentsCheck(name, dir)
      if (a) checks.push(a)
    }
    return checks
  }

  // A setup-token subscription: the token in the secret store is the whole credential, so
  // there is no endpoint, tier or network check to make — only that the token is there and
  // looks like one.
  if (isClaudeToken(profile)) {
    const token = await secrets.get(name)
    checks.push({
      label: `Claude token (${secrets.name})`,
      status: !token ? 'fail' : looksLikeSetupToken(token) ? 'ok' : 'warn',
      detail: !token
        ? `no token stored for "${name}" — run \`ccprovider edit ${name}\` and paste the output of \`claude setup-token\``
        : looksLikeSetupToken(token) ? 'present' : 'present, but it does not look like a setup-token token (sk-ant-oat…)',
    })
    checks.push(commandCheck(name, paths, opts.env ?? process.env))
    const s = settingsCheck(opts.shared ? paths.claudeDir : dir, OWNED_ENV)
    if (s) checks.push(s)
    if (!opts.shared) {
      const a = agentsCheck(name, dir)
      if (a) checks.push(a)
    }
    return checks
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
  const settings = settingsCheck(opts.shared ? paths.claudeDir : dir, PROVIDER_OWNED_ENV)
  if (settings) checks.push(settings)
  if (!opts.shared) {
    const agents = agentsCheck(name, dir)
    if (agents) checks.push(agents)
    checks.push(...mcpChecks(name, profile, dir, key, opts.runtime))
  } else if (profile.mcp?.length) {
    checks.push({
      label: 'MCP tools',
      status: 'warn',
      detail: `cannot be installed while this profile shares its config directory — \`ccprovider settings\` (or \`ccprovider settings set shareSessions false ${name}\`) stops it sharing`,
    })
  }

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

/** The profile's ccprovider-installed agents and Explore override. Silent when there
 *  are none — the built-in agents are not something to report on. */
function agentsCheck(name: string, dir: string): Check | null {
  const installed = listInstalled(dir)
  const explore = readExplore(dir)
  if (!installed.length && !explore) return null
  const edited = [...installed.filter((a) => a.modified).map((a) => a.id), ...(explore?.modified ? ['Explore'] : [])]
  const unknown = installed.filter((a) => !a.known).map((a) => a.id)
  const parts = [
    installed.length ? `${installed.length} installed (${installed.map((a) => a.id).join(', ')})` : '',
    explore ? `Explore on ${explore.model}` : '',
    edited.length ? `edited: ${edited.join(', ')} — kept as they are` : '',
    unknown.length ? `no longer in the catalog: ${unknown.join(', ')} — \`ccprovider agents rm ${name} <id>\`` : '',
  ]
  return {
    label: 'agents',
    status: edited.length || unknown.length ? 'warn' : 'ok',
    detail: parts.filter(Boolean).join(' · '),
  }
}

/** Does typing `<name>` in a shell run this profile? */
function commandCheck(name: string, paths: Paths, env: Record<string, string | undefined>): Check {
  const label = `command \`${name}\``
  // The slot `add --default` writes has no launcher of its own: `claude` is its command, and
  // the "default command" section checks that wrapper.
  if (name === DEFAULT_SLOT && currentDefaultProfile(paths) === name) {
    return { label: 'command `claude`', status: 'ok', detail: 'runs this profile — see "default command" below' }
  }
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
    return { label, status: 'warn', detail: `installed, but ${paths.binDir} is not on PATH — \`ccprovider init\` adds it (zsh and bash)` }
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
/** A provider profile also owns the variables set for providers only; a subscription does not. */
const PROVIDER_OWNED_ENV = new Set<string>([...OWNED_ENV, ...PROVIDER_VARS])

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
function settingsCheck(dir: string, owned: Set<string>): Check | null {
  const file = join(dir, 'settings.json')
  let env: unknown
  try {
    env = (JSON.parse(readFileSync(file, 'utf8')) as { env?: unknown }).env
  } catch {
    return null // no settings file, or not ours to judge
  }
  const keys = typeof env === 'object' && env !== null ? Object.keys(env).filter((k) => owned.has(k)) : []
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

/** The plain `claude` command, once a profile has been made its default. About the
 *  install and not any one profile, so it is reported once. Says nothing when there is no
 *  default: that is the ordinary state, not a finding. */
export function defaultChecks(paths: Paths, knownProfiles: string[], env: Record<string, string | undefined>): Check[] {
  const label = 'default command `claude`'
  const s = inspectDefaultShim(paths, env)
  if (s.state === 'absent') return []
  if (s.state === 'foreign') {
    return [{ label, status: 'warn', detail: `${s.path} is not a ccprovider wrapper, so \`ccprovider default\` leaves it alone` }]
  }
  if (!knownProfiles.includes(s.profile!)) {
    return [{
      label,
      status: 'fail',
      detail: `runs profile "${s.profile}", which no longer exists, so \`claude\` fails — \`ccprovider default --off\` removes it, \`ccprovider default <profile>\` picks another`,
    }]
  }
  if (!s.targetOk) {
    return [{
      label,
      status: 'fail',
      detail: `points at ${s.launcher!.join(' ')}, which is missing or not executable — re-run \`ccprovider default ${s.profile}\``,
    }]
  }
  if (!s.dirOnPath) {
    return [{
      label,
      status: 'warn',
      detail: `installed, but ${paths.defaultBinDir} is not on PATH, so \`claude\` runs ${s.shadowedBy ?? 'nothing'} — \`ccprovider init\` puts it first (zsh and bash)`,
    }]
  }
  if (s.shadowedBy) {
    return [{ label, status: 'warn', detail: `installed, but \`claude\` resolves to ${s.shadowedBy} first` }]
  }
  return [{ label, status: 'ok', detail: `runs "${s.profile}"` }]
}

/** The token footer, once installed. Install-wide, since every profile reads the same
 *  settings.json. Says nothing when it was never installed or the status line is someone
 *  else's: those are choices, not findings. */
export function statuslineChecks(paths: Paths, shipped: string = STATUSLINE_SOURCE.version): Check[] {
  const label = 'token footer'
  const s = inspectStatusline(paths.claudeDir, process.env, paths.dirsRoot)
  if (s.state !== 'ours') return []
  if (!s.working) {
    // A status line command that fails shows nothing at all, other badges included.
    return [{
      label,
      status: 'fail',
      detail: `the script or interpreter it runs is missing, which hides the whole status bar — run \`ccprovider statusline add\` to repair it`,
    }]
  }
  if (s.misplaced) {
    const owner = relative(paths.dirsRoot, s.misplaced).split(sep)[0]
    return [{
      label,
      status: 'warn',
      detail: `runs from the "${owner}" profile's directory (${s.misplaced}), so removing that profile hides the status bar in every profile — \`ccprovider statusline add\` moves it into ${join(paths.claudeDir, 'hooks')}`,
    }]
  }
  // The user's own script runs the badge: upstream stamps no version for that, and what it
  // runs is theirs to keep up to date.
  if (s.combined) return [{ label, status: 'ok', detail: 'run by your own status line script' }]
  if (s.version === undefined || compareVersions(s.version, shipped) < 0) {
    return [{ label, status: 'warn', detail: `installed ${s.version ? `v${s.version}` : 'from an unknown version'}, ccprovider ships v${shipped} — \`ccprovider statusline add\` updates it` }]
  }
  // Newer is fine: the Claude plugin's own hook can install one, and `add` leaves it be.
  const newer = compareVersions(s.version, shipped) > 0 ? `, newer than the v${shipped} ccprovider ships` : ''
  return [{ label, status: 'ok', detail: `v${s.version}${newer}, shown in every profile` }]
}

/** The default slot's side of the house: each provider it stashed still has what swapping back
 *  needs, and the file does not outlive the profile it describes. A whole-install check. */
export async function slotChecks(paths: Paths, secrets: SecretStore, knownProfiles: string[]): Promise<Check[]> {
  if (!existsSync(slotFilePath(paths))) return []
  let slot
  try {
    slot = loadSlot(paths)
  } catch (e) {
    return [{ label: 'slot file', status: 'fail', detail: (e as Error).message }]
  }
  const checks: Check[] = []
  const keys = Object.keys(slot.variants).sort()
  if (!knownProfiles.includes(DEFAULT_SLOT) && (keys.length || slot.epochs.length)) {
    checks.push({
      label: 'slot file',
      status: 'warn',
      detail: `${slotFilePath(paths)} describes the default, but there is no "default" profile — \`ccprovider add --default\` sets it up again`,
    })
  }
  for (const key of keys) {
    if (isOauth(slot.variants[key]!)) {
      checks.push({ label: `stashed ${key}`, status: 'ok', detail: 'a /login: signing back in is only needed if its login was removed' })
      continue
    }
    const secret = await secrets.get(variantAccount(key))
    checks.push({
      label: `stashed ${key} (${secrets.name})`,
      status: secret ? 'ok' : 'fail',
      detail: secret ? 'key present' : `its key is gone from the secret store — \`ccprovider default --forget ${key}\` drops the entry`,
    })
  }
  return checks
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

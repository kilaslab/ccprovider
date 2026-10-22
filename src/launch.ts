import type { Profile, AliasSlot } from './types.js'
import { findOnPath, isDefaultWrapper } from './shim.js'
import { TIERS, REQUIRED_SLOTS, OPUSPLAN, isClaude, isClaudeToken } from './types.js'

/** Env var Claude Code reads for each alias slot. */
export const SLOT_ENV: Record<AliasSlot, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
}

/** Variables removed from the child environment before launch.
 *
 *  Every one of these silently competes with a profile if left inherited: a stray
 *  ANTHROPIC_API_KEY can win over ANTHROPIC_AUTH_TOKEN, and the Bedrock/Vertex flags
 *  switch Claude Code to a different request format entirely. */
export const STRIPPED_VARS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_SMALL_FAST_MODEL', // deprecated alias of ANTHROPIC_DEFAULT_HAIKU_MODEL
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',

  // A Claude subscription credential must never reach a third-party endpoint —
  // that is the one thing in this space that actually violates Anthropic's terms.
  // Users who ran `claude setup-token` for CI have this exported.
  'CLAUDE_CODE_OAUTH_TOKEN',
  // Headers a user configured for api.anthropic.com would be replayed verbatim
  // to whatever host the profile points at.
  'ANTHROPIC_CUSTOM_HEADERS',

  // Session-scoped vars an already-running Claude Code exports to its children.
  // Running `ccprovider use` from inside a Claude Code session is the most natural
  // way to try this tool, and inheriting these hands the new instance the parent's
  // session identity and IPC endpoint — it would attach to the wrong session rather
  // than start a clean one. Stripped by exact name, never by CLAUDE_CODE_* prefix,
  // so deliberate global settings (telemetry, traffic flags) still pass through.
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
] as const

/** The credentials and routing flags among STRIPPED_VARS: what, left in the environment, hands
 *  someone's credential or request to the wrong place. Measured against a fake provider: an
 *  inherited ANTHROPIC_API_KEY and ANTHROPIC_CUSTOM_HEADERS were both sent to it, and
 *  CLAUDE_CODE_USE_BEDROCK kept any request from reaching it at all. Emptied, none of that
 *  happened and routing was normal. `use` deletes them; `ccprovider env` neutralises them for
 *  the shell, file or SDK that cannot. */
export const CREDENTIAL_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_BEDROCK_BASE_URL',
  'ANTHROPIC_VERTEX_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const

/**
 * Every variable buildEnv is responsible for. All are cleared before anything is set,
 * so a slot the profile does not map ends up *unset* rather than inheriting whatever
 * the user's shell had.
 *
 * This is the structural fix for a leak, not a list of known offenders: any variable
 * set conditionally is a variable that can leak, so the invariant is that buildEnv
 * fully owns this namespace.
 */
export const MANAGED_VARS = [
  'CLAUDE_CONFIG_DIR',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  ...Object.values(SLOT_ENV),
  // Set only for a claude-token profile; cleared for every other kind so a token exported in
  // the shell never reaches a provider (STRIPPED_VARS) or rides along unasked.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_EFFORT_LEVEL',
] as const

/** Variables set for a provider profile only. A subscription profile talks to Anthropic, so
 *  they are neither cleared nor forced there and the user's own value passes through.
 *
 *  ENABLE_TOOL_SEARCH=false makes Claude Code send every tool's schema up front. With it on,
 *  most tools arrive as names to be loaded through a ToolSearch tool, which third-party
 *  models do not use: glm-5.3-flash treated ToolSearch as its only tool and said it had no
 *  Bash, with Bash in the session's tool list. */
export const PROVIDER_VARS = ['ENABLE_TOOL_SEARCH'] as const

export interface LaunchOptions {
  profile: Profile
  /** The directory to export as CLAUDE_CONFIG_DIR, or null to leave it unset. */
  configDir: string | null
  apiKey: string
  /** A tier name (`opus`, `sonnet`, …) or a raw provider model ID. */
  model?: string | null
  baseEnv: NodeJS.ProcessEnv
}

export class LaunchError extends Error {}

/** Resolve `-m` into a concrete model ID. A tier name maps through the profile's
 *  aliases; `opusplan` passes through for Claude Code to resolve, once both of its
 *  tiers are mapped; anything else is passed through as a provider model ID. */
export function resolveModel(profile: Profile, requested?: string | null): string {
  if ((requested || profile.defaultModel) === OPUSPLAN) {
    const unmapped = (['opus', 'sonnet'] as const).filter((t) => !profile.aliases[t])
    if (unmapped.length) {
      throw new LaunchError(
        `opusplan plans on the "opus" tier and executes on "sonnet", but this profile has no model mapped to ` +
          `${unmapped.map((t) => `"${t}"`).join(' or ')}. Run \`ccprovider edit\` to map it.`,
      )
    }
    return OPUSPLAN
  }
  if (requested) {
    const tier = TIERS.find((t) => t === requested)
    if (tier) {
      const mapped = profile.aliases[tier]
      if (!mapped) {
        throw new LaunchError(
          `This profile has no model mapped to the "${tier}" tier. ` +
            `Run \`ccprovider edit\` to map it, or pass a provider model ID directly.`,
        )
      }
      return mapped
    }
    return requested
  }
  const fallback = profile.defaultModel || profile.aliases.opus
  if (!fallback) {
    throw new LaunchError('This profile has no default model and no "opus" alias to fall back to.')
  }
  return fallback
}

/** Which choice the profile's start model corresponds to, so `edit` can preselect it
 *  instead of quietly resetting it to opus. `custom` is a model ID that is neither
 *  session tier, e.g. one written into providers.json by hand. */
export function startChoiceOf(profile: Profile): 'opus' | 'sonnet' | 'opusplan' | 'custom' {
  const d = profile.defaultModel
  if (d === OPUSPLAN) return 'opusplan'
  if (!d || d === profile.aliases.opus) return 'opus'
  if (d === profile.aliases.sonnet) return 'sonnet'
  return 'custom'
}

/** Slots a session can request that this profile leaves unmapped. Each one is a
 *  request that would go out carrying a Claude model ID the provider does not have. */
export function missingSlots(profile: Profile): AliasSlot[] {
  if (isClaude(profile)) return []
  return REQUIRED_SLOTS.filter((s) => !profile.aliases[s])
}

/**
 * Build the child environment. Pure — no I/O, no process state — so it can be
 * asserted exhaustively in tests.
 */
export function buildEnv(opts: LaunchOptions): Record<string, string> {
  const { profile, configDir, apiKey, baseEnv } = opts

  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(baseEnv)) {
    if (typeof v === 'string') env[k] = v
  }
  for (const key of STRIPPED_VARS) delete env[key]
  // Clear the whole managed namespace first. An inherited ANTHROPIC_DEFAULT_HAIKU_MODEL
  // pointing at a Claude model is precisely the silent 404 this tool exists to prevent,
  // so leaving one in place for an unmapped slot would be self-defeating.
  for (const key of MANAGED_VARS) delete env[key]

  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  // A subscription profile talks to Anthropic with the login stored in its own config
  // directory, so nothing else is injected — the strip pass above already removed
  // anything inherited that would compete with that login.
  if (profile.kind === 'oauth') return env
  // A setup-token subscription: the token is the whole credential, and it goes to Anthropic
  // only. No base URL, model or tool-search settings — this is stock Claude Code.
  if (isClaudeToken(profile)) {
    env.CLAUDE_CODE_OAUTH_TOKEN = apiKey
    return env
  }

  env.ANTHROPIC_BASE_URL = profile.baseUrl
  env.ANTHROPIC_AUTH_TOKEN = apiKey

  // Some providers document an explicitly blank ANTHROPIC_API_KEY rather than an
  // absent one. Re-added after the strip pass so it lands as "" and not inherited.
  if (profile.blankApiKey) env.ANTHROPIC_API_KEY = ''

  env.ENABLE_TOOL_SEARCH = 'false'

  for (const slot of Object.keys(SLOT_ENV) as AliasSlot[]) {
    const model = profile.aliases[slot]
    if (model) env[SLOT_ENV[slot]] = model
  }

  env.ANTHROPIC_MODEL = resolveModel(profile, opts.model)

  // Claude Code assumes a 200k window for model IDs it does not recognise — which is
  // every third-party ID — and truncates to it. Telling it the real size is the only
  // way a 262k or 1M model gets used fully.
  if (profile.contextTokens != null) {
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(profile.contextTokens)
  }
  if (profile.autoCompactWindow != null) {
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(profile.autoCompactWindow)
  }
  if (profile.maxOutputTokens != null) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(profile.maxOutputTokens)
  }
  if (profile.effortLevel) {
    env.CLAUDE_CODE_EFFORT_LEVEL = profile.effortLevel
  }

  return env
}

/** Env vars this tool sets, for `ccprovider env` and diagnostics. Never includes
 *  the auth token's value. */
export function describeEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of [...MANAGED_VARS, ...PROVIDER_VARS]) {
    if (k in env) out[k] = k === 'ANTHROPIC_AUTH_TOKEN' || k === 'CLAUDE_CODE_OAUTH_TOKEN' ? redact(env[k]!) : env[k]!
  }
  return out
}

export function redact(secret: string): string {
  if (secret.length <= 8) return '****'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

/** What the default wrapper says when it passes a `claude` through instead of moving it to the
 *  default profile, because it was run inside a session ccprovider started. Said to a person at
 *  a terminal, who may not expect it (a tmux begun from a session), and not to a hook or a
 *  subagent, whose stderr is better left clean. */
export function passThroughNotice(tty: boolean): string | null {
  return tty
    ? 'ccprovider: this is inside a ccprovider session, so `claude` runs on that session\'s provider, not the default profile. ' +
        'Open a terminal that was not started from a session for the default (`ccprovider default` shows it, `ccprovider default --off` removes it).'
    : null
}

/** Resolve the `claude` binary from PATH.
 *
 *  `skipDirs` is where a wrapper called `claude` may sit, namely the directory
 *  `ccprovider default` writes into. That wrapper runs `ccprovider use`, which comes here,
 *  so taking PATH's first match would find the wrapper again and run it forever. */
export function findClaude(env: Record<string, string | undefined>, skipDirs: string[] = []): string {
  const found = findOnPath('claude', env.PATH, skipDirs, isDefaultWrapper)
  if (!found) throw new LaunchError('Could not find `claude` on your PATH. Install Claude Code first: https://claude.com/code')
  return found
}

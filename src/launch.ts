import { execFileSync } from 'node:child_process'
import type { Profile, AliasSlot } from './types.js'
import { TIERS, REQUIRED_SLOTS } from './types.js'

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
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_EFFORT_LEVEL',
] as const

export interface LaunchOptions {
  profile: Profile
  configDir: string
  apiKey: string
  /** A tier name (`opus`, `sonnet`, …) or a raw provider model ID. */
  model?: string | null
  baseEnv: NodeJS.ProcessEnv
}

export class LaunchError extends Error {}

/** Resolve `-m` into a concrete model ID. A tier name maps through the profile's
 *  aliases; anything else is passed through as a provider model ID. */
export function resolveModel(profile: Profile, requested?: string | null): string {
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

/** Slots a session can request that this profile leaves unmapped. Each one is a
 *  request that would go out carrying a Claude model ID the provider does not have. */
export function missingSlots(profile: Profile): AliasSlot[] {
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

  env.CLAUDE_CONFIG_DIR = configDir
  env.ANTHROPIC_BASE_URL = profile.baseUrl
  env.ANTHROPIC_AUTH_TOKEN = apiKey

  // Some providers document an explicitly blank ANTHROPIC_API_KEY rather than an
  // absent one. Re-added after the strip pass so it lands as "" and not inherited.
  if (profile.blankApiKey) env.ANTHROPIC_API_KEY = ''

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
  for (const k of MANAGED_VARS) {
    if (k in env) out[k] = k === 'ANTHROPIC_AUTH_TOKEN' ? redact(env[k]!) : env[k]!
  }
  return out
}

export function redact(secret: string): string {
  if (secret.length <= 8) return '****'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

/** Resolve the `claude` binary from PATH.
 *
 *  Note this takes PATH's first match as-is. If a user has their own wrapper named
 *  `claude` that shells out to ccprovider, that recurses — detecting it reliably would
 *  mean inspecting the target, which is not worth the complexity for a self-inflicted
 *  setup. `doctor` prints the resolved path so it is visible. */
export function findClaude(env: Record<string, string>): string {
  try {
    const out = execFileSync('which', ['claude'], {
      encoding: 'utf8',
      env,
    })
    const path = out.trim().split('\n')[0]
    if (!path) throw new Error('empty')
    return path
  } catch {
    throw new LaunchError(
      'Could not find `claude` on your PATH. Install Claude Code first: https://claude.com/code',
    )
  }
}

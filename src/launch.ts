import { execFileSync } from 'node:child_process'
import type { Profile, AliasSlot } from './types.js'
import { TIERS, REQUIRED_SLOTS } from './types.js'

/** Variables removed from the child environment before launch.
 *
 *  Every one of these silently competes with a profile if left inherited: a stray
 *  ANTHROPIC_API_KEY can win over ANTHROPIC_AUTH_TOKEN, the Bedrock/Vertex flags
 *  switch Claude Code to a different request format entirely, and a global
 *  CLAUDE_CODE_MAX_CONTEXT_TOKENS overrides the window the profile just set. */
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
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',

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

/** Env var Claude Code reads for each alias slot. */
export const SLOT_ENV: Record<AliasSlot, string> = {
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  subagent: 'CLAUDE_CODE_SUBAGENT_MODEL',
}

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
  const managed = [
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    ...Object.values(SLOT_ENV),
    'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'CLAUDE_CODE_EFFORT_LEVEL',
  ]
  const out: Record<string, string> = {}
  for (const k of managed) {
    if (k in env) out[k] = k === 'ANTHROPIC_AUTH_TOKEN' ? redact(env[k]!) : env[k]!
  }
  return out
}

export function redact(secret: string): string {
  if (secret.length <= 8) return '****'
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}

/** Resolve the real `claude` binary, skipping any shim that would recurse back here. */
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

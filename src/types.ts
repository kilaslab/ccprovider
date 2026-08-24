/** Model tiers Claude Code resolves by name. Every one that a session can request
 *  must be mapped, or the request goes out carrying a Claude model ID the provider
 *  has never heard of. */
export const TIERS = ['opus', 'sonnet', 'haiku', 'fable'] as const
export type Tier = (typeof TIERS)[number]

/** `subagent` is not a picker tier — it is a separate slot Claude Code reads when
 *  spawning Task agents. Kept alongside the tiers because it fails the same way. */
export type AliasSlot = Tier | 'subagent'
export const ALIAS_SLOTS: readonly AliasSlot[] = [...TIERS, 'subagent']

/** Slots a profile must fill for a session to work end to end. `fable` is optional:
 *  a provider with nothing to map it to is better off leaving it unset than pointing
 *  it at a model that behaves nothing like the tier. */
export const REQUIRED_SLOTS: readonly AliasSlot[] = ['opus', 'sonnet', 'haiku', 'subagent']

export interface Profile {
  /** Anthropic-format endpoint, e.g. https://api.deepseek.com/anthropic */
  baseUrl: string
  /** Tier -> provider model ID. Values may carry a `[1m]` suffix, which Claude Code
   *  reads per-variable and strips before the ID reaches the provider. */
  aliases: Partial<Record<AliasSlot, string>>
  /** Model for the session itself. Defaults to the `opus` alias when unset. */
  defaultModel?: string | null
  /** Where auto-compaction triggers. Conventionally ~75% of the real context window. */
  autoCompactWindow?: number | null
  maxOutputTokens?: number | null
  effortLevel?: string | null
  /** Send ANTHROPIC_API_KEY as an empty string rather than removing it. Required by
   *  providers whose docs call for an explicitly blank value. */
  blankApiKey?: boolean
  /** Preset this profile was created from, for `edit` and diagnostics. */
  preset?: string
  createdAt?: string
}

export interface ProfileStore {
  version: 1
  providers: Record<string, Profile>
}

export interface Preset {
  id: string
  label: string
  baseUrl: string
  /** Docs URL shown in the wizard so the user can check current model IDs themselves. */
  docs?: string
  /** Provider's model-list endpoint. Fetched with the user's key during setup so a
   *  stale static default self-corrects. Only OpenRouter's is publicly readable. */
  modelsUrl?: string
  /** Rich catalog handling. OpenRouter exposes context length, tool support and
   *  pricing per model; other providers return bare IDs. */
  liveCatalog?: 'openrouter'
  /** Provenance of this preset's alias mapping, so guesses are distinguishable
   *  from values taken off a provider's own documentation. */
  sourced?: 'deepseek-official-docs' | 'openrouter-docs' | 'kimi-docs-model-list' | 'catalog-inferred' | 'user-supplied'
  aliases?: Partial<Record<AliasSlot, string>>
  defaultModel?: string
  autoCompactWindow?: number
  maxOutputTokens?: number
  effortLevel?: string
  blankApiKey?: boolean
}

/** Strip the `[1m]` context-window suffix from a model ID. Claude Code does this
 *  before sending, so anything that compares against a provider's catalog must too. */
export function stripSuffix(modelId: string): string {
  return modelId.replace(/\[1m\]$/, '')
}

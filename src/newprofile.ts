import type { AliasSlot, Profile } from './types.js'

/** What the add wizard, and `add` with flags, settle on for a provider profile. One builder for
 *  both, so a profile made either way has exactly the same shape. */
export interface ProviderAnswers {
  baseUrl: string
  aliases: Partial<Record<AliasSlot, string>>
  defaultModel: string | null
  contextTokens: number | null
  autoCompactWindow: number | null
  maxOutputTokens: number | null
  effortLevel: string | null
  blankApiKey: boolean
  preset: string
  mcp: string[] | undefined
  /** What to store: undefined means "follow the global default" (see `shareOverride`). */
  shareSessions: boolean | undefined
  createdAt: string
}

export function buildProfile(a: ProviderAnswers): Profile {
  return {
    baseUrl: a.baseUrl,
    aliases: a.aliases,
    defaultModel: a.defaultModel,
    contextTokens: a.contextTokens,
    autoCompactWindow: a.autoCompactWindow,
    maxOutputTokens: a.maxOutputTokens,
    effortLevel: a.effortLevel,
    blankApiKey: a.blankApiKey,
    preset: a.preset,
    mcp: a.mcp,
    ...(a.shareSessions !== undefined ? { shareSessions: a.shareSessions } : {}),
    createdAt: a.createdAt,
  }
}

/** A `/login` subscription profile: no endpoint, no key, and it never shares. */
export function buildOauthProfile(createdAt: string): Profile {
  return { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude', createdAt }
}

/** A subscription profile signed in with a `claude setup-token` token. */
export function buildTokenProfile(shareSessions: boolean | undefined, createdAt: string): Profile {
  return {
    kind: 'claude-token',
    baseUrl: '',
    aliases: {},
    preset: 'claude-token',
    ...(shareSessions !== undefined ? { shareSessions } : {}),
    createdAt,
  }
}

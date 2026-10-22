import { AGENT_CATALOG } from './agents.js'
import { DEFAULT_SLOT } from './defaultslot.js'
import { regionFor } from './mcp.js'
import { buildOauthProfile, buildProfile, buildTokenProfile } from './newprofile.js'
import { OPENAI_GUIDANCE, probeEndpoint, probeModel } from './probe.js'
import { PRESETS, compactWindowFor, findPreset } from './presets.js'
import { ProfileError, assertNotReserved } from './profile.js'
import { shareOverride, sharesSessions, type Settings } from './settings.js'
import { isOauth, type AliasSlot, type Profile } from './types.js'
import type { WizardResult } from './tui/wizard.js'

/** Everything `add` can be told on the command line instead of asked. The presence of
 *  `provider` is what switches the wizard off. */
export interface AddFlags {
  provider: string
  name?: string
  baseUrl?: string
  keyStdin?: boolean
  opus?: string
  sonnet?: string
  haiku?: string
  subagent?: string
  start?: string
  context?: string
  compact?: string
  /** undefined: follow the global default */
  shareSessions?: boolean
  agents?: string
  explore?: string
  mcp?: string
  noProbe?: boolean
}

/** The flags that only mean something next to `--provider`. */
export const ADD_ONLY_FLAGS = [
  'name', 'base-url', 'key-stdin', 'opus', 'sonnet', 'haiku', 'subagent', 'start', 'context', 'compact',
  'share-sessions', 'no-share-sessions', 'agents', 'explore', 'mcp', 'no-probe',
] as const

/** `add`'s flags from what `parseArgs` returned. Null when `--provider` is absent, which keeps
 *  the wizard; any other add-only flag without it is refused, because it would otherwise be
 *  ignored without a word while the wizard asked everything anyway. */
export function addFlagsFromArgs(values: Record<string, unknown>): AddFlags | null {
  const str = (k: string) => (typeof values[k] === 'string' ? (values[k] as string) : undefined)
  const on = (k: string) => values[k] === true
  const given = ADD_ONLY_FLAGS.filter((f) => values[f] !== undefined && values[f] !== false)
  const provider = str('provider')
  if (provider === undefined) {
    if (given.length) throw new ProfileError(`--${given[0]} only applies together with --provider: without it \`add\` asks every question.`)
    return null
  }
  if (on('share-sessions') && on('no-share-sessions')) throw new ProfileError('Give --share-sessions or --no-share-sessions, not both.')
  return {
    provider,
    name: str('name'),
    baseUrl: str('base-url'),
    keyStdin: on('key-stdin'),
    opus: str('opus'),
    sonnet: str('sonnet'),
    haiku: str('haiku'),
    subagent: str('subagent'),
    start: str('start'),
    context: str('context'),
    compact: str('compact'),
    shareSessions: on('share-sessions') ? true : on('no-share-sessions') ? false : undefined,
    agents: str('agents'),
    explore: str('explore'),
    mcp: str('mcp'),
    noProbe: on('no-probe'),
  }
}

export interface FlagContext {
  /** `add --default`: write the slot instead of a named profile. */
  slot: boolean
  takenNames: string[]
  settings: Settings
  /** What the slot holds now, so sharing starts from its answer as the wizard's does. */
  current?: Profile
  /** Where the key comes from. Called last, only once everything else checked out. */
  readKey: () => Promise<string>
  now?: () => string
}

/** What the flags settle on: the wizard's result, plus what the probes need. */
export interface FlagAnswers extends WizardResult {
  baseUrl: string
  /** Distinct model IDs, for the live check. Empty for a Claude subscription. */
  models: string[]
}

const CLAUDE_PROVIDERS = ['claude', 'claude-token']

/** Only the Claude kinds, which have no endpoint, models or MCP servers of their own. */
const PROVIDER_ONLY: Array<[keyof AddFlags, string]> = [
  ['baseUrl', '--base-url'], ['opus', '--opus'], ['sonnet', '--sonnet'], ['haiku', '--haiku'], ['subagent', '--subagent'],
  ['start', '--start'], ['context', '--context'], ['compact', '--compact'], ['mcp', '--mcp'],
]

function count(value: string | undefined, flag: string, problems: string[]): number | undefined {
  if (value === undefined) return undefined
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    problems.push(`${flag} takes a positive number of tokens, not "${value}".`)
    return undefined
  }
  return Number(value)
}

function agentList(value: string | undefined, problems: string[]): string[] {
  if (value === undefined || value === 'none') return []
  if (value === 'recommended') return AGENT_CATALOG.filter((a) => a.recommended).map((a) => a.id)
  const ids = value.split(',').map((x) => x.trim()).filter(Boolean)
  const unknown = ids.filter((id) => !AGENT_CATALOG.some((a) => a.id === id))
  if (unknown.length) {
    problems.push(`--agents: unknown ${unknown.join(', ')}. Choose from ${AGENT_CATALOG.map((a) => a.id).join(', ')}, or "recommended" or "none".`)
  }
  return ids.filter((id) => !unknown.includes(id))
}

/**
 * Turn `add`'s flags into the answers the wizard would have collected, without asking anything.
 * Nothing here touches the network or a terminal; the key is read through `ctx.readKey`, and
 * the live check is `verifyProvider`. Problems are gathered and reported together, so a script
 * sees everything missing at once.
 *
 * Choices the wizard would have offered default to nothing that costs a download or a surprise:
 * no agents and no Explore override unless asked for.
 */
export async function answersFromFlags(f: AddFlags, ctx: FlagContext): Promise<FlagAnswers> {
  const problems: string[] = []
  const createdAt = ctx.now?.() ?? new Date().toISOString()
  const claude = CLAUDE_PROVIDERS.includes(f.provider)
  const preset = claude ? undefined : findPreset(f.provider)
  if (!claude && !preset) {
    throw new ProfileError(`Unknown --provider "${f.provider}". Choose one of: ${[...CLAUDE_PROVIDERS, ...PRESETS.map((x) => x.id)].join(', ')}.`)
  }

  // ---- the name
  let name = DEFAULT_SLOT
  if (ctx.slot) {
    if (f.name !== undefined) problems.push('--name does not apply with --default: that profile is always called "default".')
  } else {
    const raw = f.name ?? (claude ? undefined : f.provider)
    if (!raw) {
      problems.push(`--name is required with --provider ${f.provider}.`)
    } else {
      try {
        name = assertNotReserved(raw)
        if (ctx.takenNames.some((t) => t.toLowerCase() === name)) {
          problems.push(`A profile named "${name}" already exists. Use \`ccprovider edit ${name}\`, or give another --name.`)
        }
      } catch (e) {
        problems.push((e as Error).message)
      }
    }
  }

  // ---- sharing, agents, Explore: the questions both kinds end on
  const seed = ctx.current && !isOauth(ctx.current) ? ctx.current : undefined
  const shares = f.provider === 'claude' ? false : (f.shareSessions ?? (seed ? sharesSessions(seed, ctx.settings) : ctx.settings.shareSessions))
  if (f.provider === 'claude' && f.shareSessions === true) {
    problems.push('--share-sessions does not apply to --provider claude: a /login profile keeps its login in its own directory.')
  }
  const shareSessions = f.provider === 'claude' ? undefined : shareOverride(shares, seed?.shareSessions, ctx.settings)
  const agents = shares ? [] : agentList(f.agents, problems)
  const explore = shares || f.explore === undefined || f.explore === 'default' ? null : f.explore

  if (claude) {
    for (const [key, flag] of PROVIDER_ONLY) {
      if (f[key] !== undefined) problems.push(`${flag} does not apply to --provider ${f.provider}.`)
    }
    if (f.provider === 'claude' && f.keyStdin) problems.push('--key-stdin does not apply to --provider claude: it signs in with /login and stores no key.')
    if (f.provider === 'claude-token' && !f.keyStdin) problems.push('--provider claude-token needs --key-stdin: the token from `claude setup-token` is read from standard input, never from an argument.')
    if (problems.length) throw new ProfileError(problems.join('\n'))

    const apiKey = f.provider === 'claude-token' ? await ctx.readKey() : null
    return {
      name,
      profile: f.provider === 'claude' ? buildOauthProfile(createdAt) : buildTokenProfile(shareSessions, createdAt),
      apiKey,
      agents,
      explore,
      replace: false,
      baseUrl: '',
      models: [],
    }
  }

  // ---- a provider: endpoint, models, window
  const p = preset!
  const baseUrl = f.baseUrl ?? p.baseUrl
  if (!baseUrl) problems.push(`--base-url is required with --provider ${f.provider}.`)
  else if (!/^https?:\/\/.+/.test(baseUrl)) problems.push(`--base-url must be an http(s) URL, not "${baseUrl}".`)
  if (!f.keyStdin) problems.push('--key-stdin is required: the key is read from standard input, never from an argument.')

  const opus = f.opus ?? p.aliases?.opus
  const sonnet = f.sonnet ?? p.aliases?.sonnet ?? opus
  const haiku = f.haiku ?? p.aliases?.haiku
  const subagent = f.subagent ?? p.aliases?.subagent ?? haiku
  if (!opus) problems.push(`--opus is required with --provider ${f.provider}.`)
  if (!haiku) problems.push(`--haiku is required with --provider ${f.provider}.`)

  // The preset's window belongs to the preset's own models: with others named, it is a guess.
  const presetModels = !!p.aliases && opus === p.aliases.opus && sonnet === p.aliases.sonnet
  const contextTokens = count(f.context, '--context', problems) ?? (presetModels ? (p.contextTokens ?? null) : null)
  const autoCompactWindow =
    count(f.compact, '--compact', problems) ??
    (contextTokens ? compactWindowFor(contextTokens) : null)

  let defaultModel: string | null = opus ?? null
  if (f.start !== undefined) {
    if (f.start === 'opus') defaultModel = opus ?? null
    else if (f.start === 'sonnet') defaultModel = sonnet ?? null
    else defaultModel = f.start // opusplan, or a provider model ID, passed through as the wizard's `keep`
  }

  let mcp: string[] | undefined
  if (f.mcp !== undefined) {
    if (!p.mcp) {
      problems.push(`--mcp does not apply: ${p.label} has no MCP servers of its own.`)
    } else if (f.mcp === 'none') {
      mcp = []
    } else {
      const ids = f.mcp.split(',').map((x) => x.trim()).filter(Boolean)
      const unknown = ids.filter((id) => !p.mcp!.servers.some((s) => s.id === id))
      if (unknown.length) problems.push(`--mcp: unknown ${unknown.join(', ')}. Choose from ${p.mcp.servers.map((s) => s.id).join(', ')}, or "none".`)
      mcp = ids.filter((id) => !unknown.includes(id))
    }
  } else if (p.mcp && regionFor(baseUrl, p) && !shares) {
    mcp = p.mcp.servers.map((s) => s.id) // what the wizard starts ticked
  }
  if (shares) mcp = undefined

  if (problems.length) throw new ProfileError(problems.join('\n'))

  const aliases: Partial<Record<AliasSlot, string>> = { opus: opus!, sonnet: sonnet!, haiku: haiku!, subagent: subagent! }
  const apiKey = await ctx.readKey()
  return {
    name,
    profile: buildProfile({
      baseUrl,
      aliases,
      defaultModel,
      contextTokens,
      autoCompactWindow,
      maxOutputTokens: presetModels ? (p.maxOutputTokens ?? null) : null,
      effortLevel: p.effortLevel ?? null,
      blankApiKey: p.blankApiKey ?? false,
      preset: p.id,
      mcp,
      shareSessions,
      createdAt,
    }),
    apiKey,
    agents,
    explore,
    replace: false,
    baseUrl,
    models: [...new Set(Object.values(aliases))],
  }
}

/** The check the wizard makes before saving, for a run with no one to ask. Where the wizard
 *  offers "save anyway", this throws: `--no-probe` is how a script says it knows better. */
export async function verifyProvider(a: FlagAnswers, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (!a.baseUrl) return
  const verdict = await probeEndpoint(a.baseUrl, fetchImpl)
  if (verdict.kind === 'openai-only') throw new ProfileError(`${a.baseUrl} speaks the OpenAI format, not Anthropic's.\n${OPENAI_GUIDANCE(a.baseUrl)}`)
  if (verdict.kind === 'unreachable') throw new ProfileError(`Could not reach ${a.baseUrl}: ${verdict.detail}. Nothing was saved; --no-probe saves without checking.`)
  if (verdict.kind === 'unknown') throw new ProfileError(`${a.baseUrl} answered HTTP ${verdict.status}, which is not what an Anthropic-format endpoint says. Nothing was saved; --no-probe saves without checking.`)

  const live = await Promise.all(a.models.map(async (model) => ({ model, result: await probeModel(a.baseUrl, a.apiKey!, model, fetchImpl) })))
  const rejected = live.filter((r) => !r.result.ok)
  if (rejected.length) {
    const slots = a.profile.aliases
    const lines = rejected.map(({ model, result }) => {
      const where = (Object.keys(slots) as AliasSlot[]).filter((s) => slots[s] === model).join(', ')
      return `${where} → ${model}: ${result.error ?? `HTTP ${result.status}`}`
    })
    throw new ProfileError(`The provider rejected the request. Nothing was saved; --no-probe saves without checking.\n${lines.join('\n')}`)
  }
}

import { describe, expect, test } from 'bun:test'
import { addFlagsFromArgs, answersFromFlags, verifyProvider, type AddFlags, type FlagContext } from '../src/addflags.js'
import { readSecretFromStdin } from '../src/stdin.js'
import { ProfileError } from '../src/profile.js'
import { OPUSPLAN, type Profile } from '../src/types.js'
import { Readable } from 'node:stream'

const off = { version: 1 as const, shareSessions: false }
const on = { version: 1 as const, shareSessions: true }

const ctx = (over: Partial<FlagContext> = {}): FlagContext => ({
  slot: false,
  takenNames: [],
  settings: off,
  readKey: async () => 'the-key',
  now: () => '2026-10-22T00:00:00.000Z',
  ...over,
})
const flags = (over: Partial<AddFlags> = {}): AddFlags => ({ provider: 'deepseek', keyStdin: true, ...over })
const problems = (f: AddFlags, c: FlagContext = ctx()) => answersFromFlags(f, c).then(() => '', (e: Error) => e.message)

describe('add flags: a provider with a preset', () => {
  test('takes everything from the preset', async () => {
    const a = await answersFromFlags(flags(), ctx())
    expect(a.name).toBe('deepseek')
    expect(a.apiKey).toBe('the-key')
    expect(a.profile).toMatchObject({
      baseUrl: 'https://api.deepseek.com/anthropic',
      aliases: { opus: 'deepseek-v4-pro[1m]', sonnet: 'deepseek-v4-pro[1m]', haiku: 'deepseek-v4-flash', subagent: 'deepseek-v4-flash' },
      defaultModel: 'deepseek-v4-pro[1m]',
      contextTokens: 1048576,
      autoCompactWindow: 786432,
      effortLevel: 'max',
      preset: 'deepseek',
    })
    expect(a.models.sort()).toEqual(['deepseek-v4-flash', 'deepseek-v4-pro[1m]'])
    // Nothing that costs a download or a surprise unless asked for.
    expect(a.agents).toEqual([])
    expect(a.explore).toBeNull()
    expect(a.replace).toBe(false)
  })

  test('naming other models drops the preset\'s context window, which belonged to its own', async () => {
    const a = await answersFromFlags(flags({ opus: 'other-model', sonnet: 'other-model' }), ctx())
    expect(a.profile.contextTokens).toBeNull()
    expect(a.profile.autoCompactWindow).toBeNull()
  })

  test('--context sets the window and derives the compact point from it', async () => {
    const a = await answersFromFlags(flags({ opus: 'm', haiku: 'f', context: '262144' }), ctx())
    expect(a.profile.contextTokens).toBe(262144)
    expect(a.profile.autoCompactWindow).toBe(196608)
    const b = await answersFromFlags(flags({ opus: 'm', haiku: 'f', context: '262144', compact: '100000' }), ctx())
    expect(b.profile.autoCompactWindow).toBe(100000)
  })

  test('--start picks the tier, opusplan, or a model ID', async () => {
    const split = { opus: 'big', sonnet: 'small', haiku: 'tiny' }
    expect((await answersFromFlags(flags(split), ctx())).profile.defaultModel).toBe('big')
    expect((await answersFromFlags(flags({ ...split, start: 'sonnet' }), ctx())).profile.defaultModel).toBe('small')
    expect((await answersFromFlags(flags({ ...split, start: 'opusplan' }), ctx())).profile.defaultModel).toBe(OPUSPLAN)
    expect((await answersFromFlags(flags({ ...split, start: 'some-id' }), ctx())).profile.defaultModel).toBe('some-id')
  })

  test('refuses what is missing, all of it at once, and does not read the key first', async () => {
    let read = false
    const message = await problems(flags({ provider: 'openrouter', keyStdin: false }), ctx({ readKey: async () => { read = true; return 'k' } }))
    expect(message).toContain('--key-stdin is required')
    expect(message).toContain('--opus is required')
    expect(message).toContain('--haiku is required')
    expect(read).toBe(false)
  })

  test('openrouter and custom need models, and custom needs an endpoint', async () => {
    const a = await answersFromFlags(flags({ provider: 'openrouter', opus: 'anthropic/x', haiku: 'anthropic/y' }), ctx())
    expect(a.profile.aliases).toEqual({ opus: 'anthropic/x', sonnet: 'anthropic/x', haiku: 'anthropic/y', subagent: 'anthropic/y' })
    expect(a.profile.blankApiKey).toBe(true)
    expect(await problems(flags({ provider: 'custom', opus: 'm', haiku: 'f' }))).toContain('--base-url is required')
    expect(await problems(flags({ provider: 'custom', opus: 'm', haiku: 'f', baseUrl: 'ftp://x' }))).toContain('http(s)')
  })

  test('rejects a made-up provider and a number that is not one', async () => {
    expect(await problems(flags({ provider: 'nope' }))).toContain('Unknown --provider')
    expect(await problems(flags({ context: 'lots' }))).toContain('--context takes a positive number')
  })

  test('MCP servers: the preset\'s all, none, a chosen few, or an unknown one', async () => {
    const glm = (over: Partial<AddFlags> = {}) => answersFromFlags(flags({ provider: 'glm', ...over }), ctx())
    expect((await glm()).profile.mcp).toEqual(['zai-mcp-server', 'web-search-prime', 'web-reader', 'zread'])
    expect((await glm({ mcp: 'none' })).profile.mcp).toEqual([])
    expect((await glm({ mcp: 'zread' })).profile.mcp).toEqual(['zread'])
    expect(await problems(flags({ provider: 'glm', mcp: 'nope' }))).toContain('unknown nope')
    expect(await problems(flags({ mcp: 'x' }))).toContain('no MCP servers')
    // A gateway in front of the provider has none of the provider's MCP hosts.
    expect((await glm({ baseUrl: 'http://localhost:4000' })).profile.mcp).toBeUndefined()
  })

  test('agents and Explore', async () => {
    expect((await answersFromFlags(flags({ agents: 'recommended' }), ctx())).agents.length).toBeGreaterThan(0)
    expect((await answersFromFlags(flags({ agents: 'debugger,qa-expert', explore: 'haiku' }), ctx()))).toMatchObject({ agents: ['debugger', 'qa-expert'], explore: 'haiku' })
    expect(await problems(flags({ agents: 'wizard' }))).toContain('--agents: unknown wizard')
  })
})

describe('add flags: sharing', () => {
  test('follows the global default and stores nothing when it agrees', async () => {
    expect((await answersFromFlags(flags(), ctx())).profile.shareSessions).toBeUndefined()
    expect((await answersFromFlags(flags(), ctx({ settings: on }))).profile.shareSessions).toBeUndefined()
  })

  test('a different answer is stored as the profile\'s own, and a sharing profile has no agents or MCP of its own', async () => {
    const yes = await answersFromFlags(flags({ provider: 'glm', shareSessions: true, agents: 'recommended', explore: 'haiku' }), ctx())
    expect(yes.profile.shareSessions).toBe(true)
    expect(yes).toMatchObject({ agents: [], explore: null })
    expect(yes.profile.mcp).toBeUndefined()
    expect((await answersFromFlags(flags({ shareSessions: false }), ctx({ settings: on }))).profile.shareSessions).toBe(false)
  })
})

describe('add flags: a Claude subscription', () => {
  test('/login needs a name, takes no key and none of the provider flags, and never shares', async () => {
    expect(await problems({ provider: 'claude' })).toContain('--name is required')
    const a = await answersFromFlags({ provider: 'claude', name: 'work' }, ctx())
    expect(a.profile.kind).toBe('oauth')
    expect(a.apiKey).toBeNull()
    expect(await problems({ provider: 'claude', name: 'work', keyStdin: true })).toContain('--key-stdin does not apply')
    expect(await problems({ provider: 'claude', name: 'work', opus: 'x' })).toContain('--opus does not apply')
    expect(await problems({ provider: 'claude', name: 'work', shareSessions: true })).toContain('--share-sessions does not apply')
  })

  test('the setup-token is read from stdin, and may share', async () => {
    const a = await answersFromFlags({ provider: 'claude-token', name: 'me', keyStdin: true, shareSessions: true }, ctx({ readKey: async () => 'sk-ant-oat01-x' }))
    expect(a.profile).toMatchObject({ kind: 'claude-token', shareSessions: true })
    expect(a.apiKey).toBe('sk-ant-oat01-x')
    expect(await problems({ provider: 'claude-token', name: 'me' })).toContain('needs --key-stdin')
  })
})

describe('add flags: names and the default slot', () => {
  test('refuses a taken name, a reserved one, and a bad one', async () => {
    expect(await problems(flags(), ctx({ takenNames: ['deepseek'] }))).toContain('already exists')
    expect(await problems(flags({ name: 'default' }))).toContain('reserved')
    expect(await problems(flags({ name: '../x' }))).toContain('not a valid profile name')
  })

  test('the slot is always called default, and its taken name is no clash', async () => {
    const a = await answersFromFlags(flags(), ctx({ slot: true, takenNames: ['default'] }))
    expect(a.name).toBe('default')
    expect(await problems(flags({ name: 'x' }), ctx({ slot: true }))).toContain('--name does not apply')
  })

  test('sharing starts from the slot\'s current answer, not the global default', async () => {
    const current: Profile = { kind: 'claude-token', baseUrl: '', aliases: {}, preset: 'claude-token', shareSessions: true }
    const a = await answersFromFlags(flags(), ctx({ slot: true, current, settings: off }))
    expect(a.profile.shareSessions).toBe(true)
  })
})

describe('add flags: from parseArgs', () => {
  test('null without --provider, an error for a lone add-only flag', () => {
    expect(addFlagsFromArgs({})).toBeNull()
    expect(addFlagsFromArgs({ 'key-stdin': false })).toBeNull()
    expect(() => addFlagsFromArgs({ opus: 'x' })).toThrow(/--opus only applies together with --provider/)
  })

  test('maps the flags, and refuses contradictory sharing', () => {
    const f = addFlagsFromArgs({ provider: 'glm', 'key-stdin': true, 'no-share-sessions': true, 'base-url': 'https://x.test' })!
    expect(f).toMatchObject({ provider: 'glm', keyStdin: true, shareSessions: false, baseUrl: 'https://x.test' })
    expect(() => addFlagsFromArgs({ provider: 'glm', 'share-sessions': true, 'no-share-sessions': true })).toThrow(ProfileError)
  })
})

describe('reading the key from stdin', () => {
  const pipe = (text: string) => Object.assign(Readable.from([text]), { isTTY: false })

  test('trims the newline', async () => {
    expect(await readSecretFromStdin(pipe('sk-1\n'))).toBe('sk-1')
  })
  test('refuses nothing and a terminal', async () => {
    await expect(readSecretFromStdin(pipe('  \n'))).rejects.toThrow(/empty/)
    await expect(readSecretFromStdin(Object.assign(Readable.from([]), { isTTY: true }))).rejects.toThrow(/terminal/)
  })
})

describe('verifying a provider with no one to ask', () => {
  const answers = async () => answersFromFlags(flags(), ctx())
  const respond = (routes: (url: string) => number): typeof fetch =>
    (async (url: string) => new Response('{}', { status: routes(String(url)) })) as unknown as typeof fetch

  test('passes when the endpoint and every model answer', async () => {
    await expect(verifyProvider(await answers(), respond((u) => (u.includes('__ccprovider_control') ? 404 : 200)))).resolves.toBeUndefined()
  })

  test('throws, and does not offer to save anyway, when a model is rejected', async () => {
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? init.body : ''
      if (url.includes('__ccprovider_control')) return new Response('{}', { status: 404 })
      if (body.includes('deepseek-v4-flash')) return new Response('{"error":{"message":"no such model"}}', { status: 404 })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await expect(verifyProvider(await answers(), fetchImpl)).rejects.toThrow(/haiku, subagent → deepseek-v4-flash: no such model/)
  })

  test('throws for an unreachable endpoint, and checks nothing for a Claude subscription', async () => {
    const boom = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    await expect(verifyProvider(await answers(), boom)).rejects.toThrow(/Could not reach/)
    await expect(verifyProvider(await answersFromFlags({ provider: 'claude', name: 'w' }, ctx()), boom)).resolves.toBeUndefined()
  })
})

import { describe, expect, test } from 'bun:test'
import { probeEndpoint, probeModel, OPENAI_GUIDANCE } from '../src/probe.js'
import { runDoctor } from '../src/doctor.js'
import { MemoryStore } from '../src/secrets/index.js'
import type { Profile } from '../src/types.js'
import type { Paths } from '../src/paths.js'

/** Route by URL so a fake provider can answer /v1/messages and /chat/completions
 *  differently — which is the whole basis of the format detection. */
function router(routes: Record<string, number>, capture?: { body?: any; url?: string; urls?: string[] }): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (capture) {
      capture.url = u
      // probeEndpoint fires the control request in parallel, so record every URL —
      // a single `url` field would race between the two.
      ;(capture.urls ??= []).push(u)
      if (init?.body) capture.body = JSON.parse(String(init.body))
    }
    const key = Object.keys(routes).find((k) => u.endsWith(k))
    const status = key ? routes[key]! : 404
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: { message: 'Model not found' } }),
    }
  }) as unknown as typeof fetch
}

describe('endpoint format detection', () => {
  test.each([[401], [403], [400], [422]])('HTTP %i on /v1/messages, with a 404 control, means the route exists', async (status) => {
    const v = await probeEndpoint('https://x.dev/anthropic', router({ '/v1/messages': status }))
    expect(v.kind).toBe('anthropic')
  })

  test('a server that answers every path alike is reported inconclusive, not as a pass', async () => {
    // Measured: DeepSeek returns 401 for /anthropic/v1/messages *and* for any bogus
    // path under /anthropic. Claiming "speaks Anthropic Messages" there would let a
    // typo'd URL through, to fail later mid-session.
    const authWall = (async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' })) as unknown as typeof fetch
    const v = await probeEndpoint('https://api.deepseek.com/anthropic', authWall)
    expect(v.kind).toBe('inconclusive')
  })

  test('a real route is still distinguished when the control 404s', async () => {
    // OpenRouter: /v1/messages -> 401, bogus path -> 404. Routing tells them apart.
    const v = await probeEndpoint('https://openrouter.ai/api', router({ '/v1/messages': 401 }))
    expect(v.kind).toBe('anthropic')
  })

  test('404 on messages + 400 on chat/completions is diagnosed as OpenAI-only', async () => {
    const v = await probeEndpoint('https://x.dev/v1', router({ '/v1/messages': 404, '/chat/completions': 400 }))
    expect(v.kind).toBe('openai-only')
  })

  test('404 everywhere is "unknown", not a wrong OpenAI diagnosis', async () => {
    const v = await probeEndpoint('https://x.dev/api', router({}))
    expect(v.kind).toBe('unknown')
  })

  test('a network failure is reported as unreachable, not as a bad format', async () => {
    const boom = (async () => { throw new Error('ENOTFOUND') }) as unknown as typeof fetch
    const v = await probeEndpoint('https://nope.invalid', boom)
    expect(v).toEqual({ kind: 'unreachable', detail: 'ENOTFOUND' })
  })

  test('a trailing slash does not produce a double slash', async () => {
    const cap: { urls?: string[] } = {}
    await probeEndpoint('https://x.dev/anthropic/', router({ '/v1/messages': 401 }, cap))
    expect(cap.urls).toContain('https://x.dev/anthropic/v1/messages')
    expect(cap.urls!.every((u) => !u.includes('//v1'))).toBe(true)
  })

  test('the control request goes to a path that cannot legitimately exist', async () => {
    const cap: { urls?: string[] } = {}
    await probeEndpoint('https://x.dev/anthropic', router({ '/v1/messages': 401 }, cap))
    expect(cap.urls).toHaveLength(2)
    expect(cap.urls!.find((u) => u.includes('control_probe'))).toBeTruthy()
  })

  test('the OpenAI guidance names the URL and a concrete next step', () => {
    const g = OPENAI_GUIDANCE('https://my.dev/v1')
    expect(g).toContain('https://my.dev/v1')
    expect(g).toContain('litellm')
  })
})

describe('per-model probe', () => {
  test('strips [1m] before sending — Claude Code does, so a suffixed alias is not broken', async () => {
    const cap: { body?: any } = {}
    await probeModel('https://x.dev/anthropic', 'k', 'deepseek-v4-pro[1m]', router({ '/v1/messages': 200 }, cap))
    expect(cap.body.model).toBe('deepseek-v4-pro')
  })

  test('asks for one token, so doctor is cheap to run', async () => {
    const cap: { body?: any } = {}
    await probeModel('https://x.dev/anthropic', 'k', 'm', router({ '/v1/messages': 200 }, cap))
    expect(cap.body.max_tokens).toBe(1)
  })

  test("surfaces the provider's own error message", async () => {
    const r = await probeModel('https://x.dev/anthropic', 'k', 'ghost', router({ '/v1/messages': 404 }))
    expect(r.ok).toBe(false)
    expect(r.error).toBe('Model not found')
  })
})

describe('doctor', () => {
  const paths: Paths = { claudeDir: '/nope/.claude', configFile: '/nope/c.json', dirsRoot: '/nope/dirs', cacheDir: '/nope/cache' }
  const profile: Profile = {
    baseUrl: 'https://x.dev/anthropic',
    aliases: { opus: 'big', sonnet: 'big', haiku: 'small', subagent: 'small' },
    defaultModel: 'big',
  }

  test('flags unmapped tiers as a failure', async () => {
    const secrets = new MemoryStore()
    const checks = await runDoctor('p', { ...profile, aliases: { opus: 'big' } }, paths, secrets, { skipNetwork: true })
    const tier = checks.find((c) => c.label === 'model tier mapping')!
    expect(tier.status).toBe('fail')
    expect(tier.detail).toContain('sonnet')
    expect(tier.detail).toContain('subagent')
  })

  test('a missing key fails and stops before any network call', async () => {
    const checks = await runDoctor('p', profile, paths, new MemoryStore(), {
      fetchImpl: (() => { throw new Error('should not be called') }) as unknown as typeof fetch,
    })
    expect(checks.find((c) => c.label.startsWith('API key'))!.status).toBe('fail')
    expect(checks.find((c) => c.label === 'endpoint format')).toBeUndefined()
  })

  test('probes every mapped slot, reporting each independently', async () => {
    const secrets = new MemoryStore()
    await secrets.set('p', 'sk-x')
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {}
      const ok = body.model !== 'small'
      return { ok, status: ok ? 200 : 404, json: async () => ({}), text: async () => '{"error":{"message":"no such model"}}' }
    }) as unknown as typeof fetch

    const checks = await runDoctor('p', profile, paths, secrets, { fetchImpl })
    const slots = checks.filter((c) => c.label.includes('->'))
    expect(slots).toHaveLength(4)
    expect(slots.filter((c) => c.status === 'ok')).toHaveLength(2)   // opus, sonnet -> big
    expect(slots.filter((c) => c.status === 'fail')).toHaveLength(2) // haiku, subagent -> small
    expect(checks.find((c) => c.label.includes('haiku'))!.detail).toBe('no such model')
  })
})

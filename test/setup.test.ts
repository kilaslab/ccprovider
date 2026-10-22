import { describe, expect, test } from 'bun:test'
import { planMcp } from '../src/setup.js'
import type { Profile } from '../src/types.js'

const glm = (mcp: string[], baseUrl = 'https://api.z.ai/api/anthropic'): Profile => ({
  baseUrl,
  aliases: { opus: 'a', sonnet: 'a', haiku: 'a', subagent: 'a' },
  preset: 'glm',
  mcp,
})
const deepseek: Profile = { baseUrl: 'https://api.deepseek.com/anthropic', aliases: { opus: 'a', sonnet: 'a', haiku: 'a', subagent: 'a' }, preset: 'deepseek' }
const token: Profile = { kind: 'claude-token', baseUrl: '', aliases: {}, preset: 'claude-token' }
const ids = (xs: Array<{ spec: { id: string } }>) => xs.map((x) => x.spec.id).sort()

describe('planMcp', () => {
  test('a new profile registers what it enables and removes nothing', () => {
    const plan = planMcp(glm(['web-search-prime', 'zread']), {})
    expect(ids(plan.wanted)).toEqual(['web-search-prime', 'zread'])
    expect(plan.unwanted).toEqual([])
  })

  test('the same provider removes only what was switched off', () => {
    const plan = planMcp(glm(['zread']), { mcp: ['web-search-prime', 'zread'], preset: 'glm' })
    expect(ids(plan.wanted)).toEqual(['zread'])
    expect(ids(plan.unwanted)).toEqual(['web-search-prime'])
  })

  // The slot keeps its directory when `add --default` changes provider; the old provider's
  // servers carry a header helper that reads this profile's key, which is now someone else's.
  test('a different provider removes everything the old one registered, even if the new one has none', () => {
    for (const next of [deepseek, token]) {
      const plan = planMcp(next, { mcp: ['web-search-prime', 'zread'], preset: 'glm' })
      expect(plan.wanted).toEqual([])
      expect(ids(plan.unwanted)).toEqual(['web-search-prime', 'zread'])
    }
  })

  test('a provider with its own servers gets them and loses the old provider\'s', () => {
    const plan = planMcp(glm(['zread']), { mcp: ['something-old'], preset: 'deepseek' })
    expect(ids(plan.wanted)).toEqual(['zread'])
    // 'something-old' is not defined by the deepseek preset, so it is not ours to remove.
    expect(plan.unwanted).toEqual([])
  })

  test('an endpoint outside every known region drops what is enabled instead of registering it', () => {
    const plan = planMcp(glm(['zread'], 'http://localhost:4000'), { mcp: ['zread'], preset: 'glm' })
    expect(plan.wanted).toEqual([])
    expect(ids(plan.unwanted)).toEqual(['zread'])
  })

  test('nothing before means nothing to remove', () => {
    expect(planMcp(deepseek, {})).toEqual({ wanted: [], unwanted: [] })
  })

  describe('removeOnly, for a profile that shares and has no directory of its own', () => {
    test('registers nothing and removes nothing while the provider is the same', () => {
      const plan = planMcp(glm(['zread']), { mcp: ['web-search-prime'], preset: 'glm' }, true)
      expect(plan).toEqual({ wanted: [], unwanted: [] })
    })

    test('still removes the old provider\'s servers when the provider changed', () => {
      const plan = planMcp(deepseek, { mcp: ['zread'], preset: 'glm' }, true)
      expect(plan.wanted).toEqual([])
      expect(ids(plan.unwanted)).toEqual(['zread'])
    })
  })
})

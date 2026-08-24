import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parseOpenRouter, toolCapable, formatPrice, fetchGenericCatalog, CatalogError } from '../src/catalog.js'

const raw = JSON.parse(readFileSync('test/fixtures/openrouter-models.json', 'utf8'))
const models = parseOpenRouter(raw)

describe('parsing the real OpenRouter shape', () => {
  test('extracts id, context length and output cap', () => {
    const m = models.find((x) => x.id === 'deepseek/deepseek-v4-pro')!
    expect(m.contextLength).toBe(1048576)
    expect(m.maxOutput).toBeGreaterThan(0)
    expect(m.label).toContain('DeepSeek')
  })

  test('reads tool support from supported_parameters', () => {
    expect(models.find((x) => x.id === 'z-ai/glm-5.3')!.supportsTools).toBe(true)
  })

  test('reads image support from input_modalities', () => {
    const m = models.find((x) => x.id === 'moonshotai/kimi-k3')!
    expect(typeof m.supportsImages).toBe('boolean')
  })

  test('prices come through as numbers', () => {
    const m = models.find((x) => x.id === 'minimax/minimax-m3')!
    expect(m.promptPrice).toBeGreaterThan(0)
    expect(formatPrice(m)).toMatch(/^\$\d+\.\d\d\/\$\d+\.\d\d per M$/)
  })

  test('rejects an unexpected response shape rather than yielding an empty list', () => {
    expect(() => parseOpenRouter({ models: [] })).toThrow(CatalogError)
  })
})

describe('the filter that matters', () => {
  test('drops models that cannot tool-call', () => {
    const kept = toolCapable(models)
    expect(kept.length).toBeLessThan(models.length)
    expect(kept.every((m) => m.supportsTools)).toBe(true)
  })

  test('every model the picker would offer can actually drive Claude Code', () => {
    expect(toolCapable(models).find((m) => !m.supportsTools)).toBeUndefined()
  })
})

describe('generic OpenAI-shaped catalogs', () => {
  const fakeFetch = (body: unknown, ok = true): typeof fetch =>
    (async () => ({ ok, status: ok ? 200 : 401, json: async () => body })) as unknown as typeof fetch

  test('reads a {data:[{id}]} list', async () => {
    const got = await fetchGenericCatalog('https://x.dev/v1/models', 'k', fakeFetch({ data: [{ id: 'kimi-k3' }, { id: 'kimi-k2.6' }] }))
    expect(got.map((m) => m.id)).toEqual(['kimi-k3', 'kimi-k2.6'])
  })

  test('treats unknown capability as usable rather than hiding every model', async () => {
    const got = await fetchGenericCatalog('https://x.dev/v1/models', 'k', fakeFetch({ data: [{ id: 'm' }] }))
    expect(got[0]!.supportsTools).toBe(true)
    expect(got[0]!.contextLength).toBeNull()
  })

  test('surfaces an auth failure instead of returning nothing', async () => {
    await expect(
      fetchGenericCatalog('https://x.dev/v1/models', 'bad', fakeFetch({}, false)),
    ).rejects.toThrow(/HTTP 401/)
  })
})

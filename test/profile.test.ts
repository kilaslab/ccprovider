import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStore, saveStore, validateStore, validateProfile, validateName, getProfile, ProfileError } from '../src/profile.js'
import { MemoryStore } from '../src/secrets/index.js'
import { FileStore } from '../src/secrets/file.js'
import type { Paths } from '../src/paths.js'

let home: string
let paths: Paths

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-prof-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, '.config/ccprovider/providers.json'),
    dirsRoot: join(home, '.local/share/ccprovider/dirs'),
    cacheDir: join(home, '.cache/ccprovider'),
    binDir: join(home, '.local/bin'),
  }
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const valid = {
  version: 1,
  providers: {
    deepseek: {
      baseUrl: 'https://api.deepseek.com/anthropic',
      aliases: { opus: 'deepseek-v4-pro[1m]', sonnet: 'deepseek-v4-pro[1m]', haiku: 'deepseek-v4-flash', subagent: 'deepseek-v4-flash' },
      defaultModel: 'deepseek-v4-pro[1m]',
      autoCompactWindow: 786432,
    },
  },
}

describe('mcp field', () => {
  const base = { baseUrl: 'https://api.z.ai/api/anthropic', aliases: { opus: 'm' } }

  test('absent stays absent — "never asked" is not "asked, and none"', () => {
    expect(validateProfile(base, 't').mcp).toBeUndefined()
  })

  test('an explicit empty list survives a save and load', () => {
    // Regression guard: collapsing [] to undefined made the wizard re-tick every server
    // on each `edit` for someone who had deliberately turned them all off.
    const store = validateStore({ version: 1, providers: { glm: { ...base, mcp: [] } } })
    saveStore(paths, store)
    expect(loadStore(paths).providers.glm!.mcp).toEqual([])
  })

  test('a chosen list round-trips and is de-duplicated', () => {
    expect(validateProfile({ ...base, mcp: ['zread', 'web-reader', 'zread'] }, 't').mcp).toEqual(['zread', 'web-reader'])
  })

  test.each([
    ['not an array', 'zread'],
    ['a non-string entry', [1]],
    ['an uppercase ID', ['Zread']],
    ['an ID with a path separator', ['../zread']],
    ['an ID with a space', ['web reader']],
    ['an empty ID', ['']],
  ])('rejects %s', (_label, mcp) => {
    expect(() => validateProfile({ ...base, mcp }, 't')).toThrow(ProfileError)
  })
})

describe('store round-trip', () => {
  test('missing config yields an empty store, not an error', () => {
    expect(loadStore(paths)).toEqual({ version: 1, providers: {} })
  })

  test('save then load preserves everything', () => {
    const store = validateStore(valid)
    saveStore(paths, store)
    expect(loadStore(paths)).toEqual(store)
  })

  test('config is written 0600 — it sits next to secrets on the file backend', () => {
    saveStore(paths, validateStore(valid))
    expect(statSync(paths.configFile).mode & 0o777).toBe(0o600)
  })

  test('save is atomic — no .tmp left behind', () => {
    saveStore(paths, validateStore(valid))
    expect(() => readFileSync(`${paths.configFile}.tmp`)).toThrow()
  })

  test('corrupt JSON reports the file path, not a bare parse error', () => {
    mkdirSync(join(home, '.config/ccprovider'), { recursive: true })
    writeFileSync(paths.configFile, '{not json')
    expect(() => loadStore(paths)).toThrow(/providers\.json is not valid JSON/)
  })
})

describe('validation', () => {
  test('rejects an unknown schema version rather than guessing', () => {
    expect(() => validateStore({ version: 2, providers: {} })).toThrow(/unsupported version 2/)
  })

  test('rejects a non-http baseUrl', () => {
    expect(() => validateProfile({ baseUrl: 'api.deepseek.com', aliases: {} }, 'p')).toThrow(/http\(s\) URL/)
  })

  test('rejects an unknown alias slot with the valid list', () => {
    expect(() => validateProfile({ baseUrl: 'https://x.dev', aliases: { turbo: 'm' } }, 'p')).toThrow(/unknown alias slot "turbo"/)
  })

  test('rejects an empty model ID', () => {
    expect(() => validateProfile({ baseUrl: 'https://x.dev', aliases: { opus: '  ' } }, 'p')).toThrow(/non-empty model ID/)
  })

  test('rejects a negative window', () => {
    expect(() => validateProfile({ baseUrl: 'https://x.dev', aliases: {}, autoCompactWindow: -1 }, 'p')).toThrow(/non-negative/)
  })

  test('names that would escape the profile directory are refused', () => {
    expect(() => validateName('../../etc')).toThrow(ProfileError)
    expect(() => validateName('a/b')).toThrow(ProfileError)
    expect(() => validateName('')).toThrow(ProfileError)
    expect(validateName('deepseek-2')).toBe('deepseek-2')
  })
})

describe('name case normalisation', () => {
  // Regression: validateName accepted mixed case and the wizard's duplicate check was
  // case-sensitive, so "DeepSeek" and "deepseek" became two config entries sharing one
  // directory on macOS/Windows. `rm` on either then destroyed the other's history.
  test('names normalise to lowercase', () => {
    expect(validateName('DeepSeek')).toBe('deepseek')
    expect(validateName('OpenRouter')).toBe('openrouter')
  })

  test('case-variant profiles in a config are rejected, not silently merged', () => {
    expect(() =>
      validateStore({
        version: 1,
        providers: {
          deepseek: { baseUrl: 'https://a.dev', aliases: {} },
          DeepSeek: { baseUrl: 'https://b.dev', aliases: {} },
        },
      }),
    ).toThrow(/collides with another profile once case is normalised/)
  })

  test('an existing mixed-case config loads under the normalised key', () => {
    const store = validateStore({ version: 1, providers: { DeepSeek: { baseUrl: 'https://a.dev', aliases: {} } } })
    expect(Object.keys(store.providers)).toEqual(['deepseek'])
    expect(() => getProfile(store, 'DeepSeek')).not.toThrow()
    expect(() => getProfile(store, 'deepseek')).not.toThrow()
  })

  test('a store key that could escape the profile directory is refused at load', () => {
    expect(() => validateStore({ version: 1, providers: { '../../evil': { baseUrl: 'https://a.dev', aliases: {} } } })).toThrow(ProfileError)
  })
})

describe('getProfile', () => {
  test('unknown name lists what does exist', () => {
    expect(() => getProfile(validateStore(valid), 'nope')).toThrow(/Known profiles: deepseek/)
  })

  test('empty store points at `ccprovider add`', () => {
    expect(() => getProfile({ version: 1, providers: {} }, 'x')).toThrow(/ccprovider add/)
  })
})

describe('secret stores', () => {
  test('MemoryStore satisfies the interface contract', async () => {
    const s = new MemoryStore()
    expect(await s.get('a')).toBeNull()
    await s.set('a', 'sk-1')
    expect(await s.get('a')).toBe('sk-1')
    await s.set('a', 'sk-2')
    expect(await s.get('a')).toBe('sk-2')
    await s.delete('a')
    expect(await s.get('a')).toBeNull()
    await s.delete('a') // deleting twice must not throw
  })

  test('FileStore round-trips and never stores the secret in cleartext', async () => {
    const dir = join(home, 'vault')
    mkdirSync(dir, { recursive: true })
    const s = new FileStore(dir)
    await s.set('deepseek', 'sk-super-secret-value')
    expect(await s.get('deepseek')).toBe('sk-super-secret-value')

    const onDisk = readFileSync(join(dir, 'secrets.enc.json'), 'utf8')
    expect(onDisk).not.toContain('sk-super-secret-value')

    expect(statSync(join(dir, 'secrets.enc.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, 'secrets.key')).mode & 0o777).toBe(0o600)

    await s.delete('deepseek')
    expect(await s.get('deepseek')).toBeNull()
  })

  test('FileStore keeps profiles independent', async () => {
    const dir = join(home, 'vault2')
    mkdirSync(dir, { recursive: true })
    const s = new FileStore(dir)
    await s.set('a', 'secret-a')
    await s.set('b', 'secret-b')
    expect(await s.get('a')).toBe('secret-a')
    expect(await s.get('b')).toBe('secret-b')
    await s.delete('a')
    expect(await s.get('b')).toBe('secret-b')
  })

  test('a tampered ciphertext fails closed instead of returning garbage', async () => {
    const dir = join(home, 'vault3')
    mkdirSync(dir, { recursive: true })
    const s = new FileStore(dir)
    await s.set('x', 'sk-original')
    const vaultPath = join(dir, 'secrets.enc.json')
    const v = JSON.parse(readFileSync(vaultPath, 'utf8'))
    const [iv, tag, data] = v.x.split('.')
    v.x = [iv, tag, Buffer.from('tampered').toString('base64')].join('.')
    writeFileSync(vaultPath, JSON.stringify(v))
    expect(await s.get('x')).toBeNull()
  })
})

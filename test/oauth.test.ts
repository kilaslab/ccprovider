import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEnv, missingSlots } from '../src/launch.js'
import { validateProfile, validateStore, ProfileError } from '../src/profile.js'
import { runDoctor } from '../src/doctor.js'
import { profileDir, type Paths } from '../src/paths.js'
import { MemoryStore } from '../src/secrets/index.js'
import { isOauth, type Profile } from '../src/types.js'

const work: Profile = { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude' }

describe('oauth profile environment', () => {
  const env = buildEnv({
    profile: work,
    configDir: '/cfg/work',
    apiKey: '',
    baseEnv: {
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'leaked',
      ANTHROPIC_API_KEY: 'leaked',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
      CLAUDE_CODE_OAUTH_TOKEN: 'leaked',
    },
  })

  test('points Claude Code at the profile directory and nothing else', () => {
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg/work')
    expect(env.PATH).toBe('/usr/bin')
  })

  test('inherited provider settings and tokens do not reach it', () => {
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      expect(env[k]).toBeUndefined()
    }
  })

  test('has no unmapped tier slots to warn about', () => {
    expect(missingSlots(work)).toEqual([])
  })
})

describe('oauth profile validation', () => {
  test('needs no baseUrl or aliases', () => {
    const p = validateProfile({ kind: 'oauth' }, 'test')
    expect(isOauth(p)).toBe(true)
    expect(p.baseUrl).toBe('')
    expect(p.aliases).toEqual({})
  })

  test('survives a store round trip alongside a provider profile', () => {
    const store = validateStore({
      version: 1,
      providers: {
        work: { kind: 'oauth' },
        deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', aliases: { opus: 'm' } },
      },
    })
    expect(isOauth(store.providers.work!)).toBe(true)
    expect(isOauth(store.providers.deepseek!)).toBe(false)
  })

  test('rejects an unknown kind', () => {
    expect(() => validateProfile({ kind: 'saml', baseUrl: 'https://x.test', aliases: {} }, 'test')).toThrow(ProfileError)
  })

  test('a profile without kind still needs a real endpoint', () => {
    expect(() => validateProfile({ aliases: {} }, 'test')).toThrow(ProfileError)
  })
})

describe('oauth profile doctor', () => {
  let home: string
  let paths: Paths
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ccprov-oauth-'))
    paths = {
      claudeDir: join(home, '.claude'),
      configFile: join(home, 'providers.json'),
      dirsRoot: join(home, 'dirs'),
      cacheDir: join(home, 'cache'),
      binDir: join(home, 'bin'),
    }
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  test('skips key, tier and network checks', async () => {
    const checks = await runDoctor('work', work, paths, new MemoryStore(), { skipNetwork: false, env: { PATH: '/usr/bin' } })
    const labels = checks.map((c) => c.label)
    expect(labels).toContain('Claude login')
    expect(labels.some((l) => l.startsWith('API key'))).toBe(false)
    expect(labels).not.toContain('model tier mapping')
    expect(labels).not.toContain('endpoint format')
  })

  test('reports credentials found in the profile directory', async () => {
    const dir = profileDir(paths, 'work')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.credentials.json'), '{}')
    const checks = await runDoctor('work', work, paths, new MemoryStore(), { env: { PATH: '/usr/bin' } })
    const login = checks.find((c) => c.label === 'Claude login')!
    expect(login.status).toBe('ok')
    expect(login.detail).toContain('found')
  })
})

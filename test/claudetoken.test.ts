import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEnv, describeEnv, missingSlots } from '../src/launch.js'
import { loadStore, saveStore, validateProfile, validateStore, ProfileError } from '../src/profile.js'
import { applyProfileShare, describeShare, sharesSessions, type Settings } from '../src/settings.js'
import { runDoctor } from '../src/doctor.js'
import { DEFAULT_SLOT, saveDefaultSlot } from '../src/defaultslot.js'
import { profileDir, type Paths } from '../src/paths.js'
import { MemoryStore } from '../src/secrets/index.js'
import { isClaude, isOauth, type Profile } from '../src/types.js'

const token: Profile = { kind: 'claude-token', baseUrl: '', aliases: {}, preset: 'claude-token' }
const SECRET = 'sk-ant-oat01-abcdefghijklmnop'
const off: Settings = { version: 1, shareSessions: false }
const on: Settings = { version: 1, shareSessions: true }

let home: string
let paths: Paths
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-token-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, 'providers.json'),
    settingsFile: join(home, 'settings.json'),
    dirsRoot: join(home, 'dirs'),
    cacheDir: join(home, 'cache'),
    binDir: join(home, 'bin'),
    defaultBinDir: join(home, 'default-bin'),
    usageDir: join(home, 'usage'),
  }
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('claude-token environment', () => {
  const env = buildEnv({
    profile: token,
    configDir: '/cfg/personal',
    apiKey: SECRET,
    baseEnv: {
      PATH: '/usr/bin',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'leaked',
      ANTHROPIC_API_KEY: 'leaked',
      ANTHROPIC_MODEL: 'deepseek-v4-pro',
      CLAUDE_CODE_OAUTH_TOKEN: 'someone-elses',
    },
  })

  test('hands over the stored token and the config dir, and nothing else', () => {
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(SECRET)
    expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg/personal')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.ENABLE_TOOL_SEARCH).toBeUndefined()
  })

  test('inherited provider settings do not reach it', () => {
    for (const k of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL']) {
      expect(env[k]).toBeUndefined()
    }
  })

  test('leaves the shared config dir unset when asked to', () => {
    expect(buildEnv({ profile: token, configDir: null, apiKey: SECRET, baseEnv: {} }).CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  test('has no unmapped tier slots to warn about', () => {
    expect(missingSlots(token)).toEqual([])
  })

  test('a token exported in the shell still never reaches a provider profile', () => {
    const provider: Profile = { baseUrl: 'https://x.test', aliases: { opus: 'm', sonnet: 'm', haiku: 'm', subagent: 'm' }, defaultModel: 'm' }
    const e = buildEnv({ profile: provider, configDir: null, apiKey: 'k', baseEnv: { CLAUDE_CODE_OAUTH_TOKEN: SECRET } })
    expect(e.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })

  test('is redacted when shown', () => {
    expect(describeEnv(env).CLAUDE_CODE_OAUTH_TOKEN).not.toContain('abcdefghij')
  })
})

describe('claude-token validation and sharing', () => {
  test('is a Claude profile but not a /login one', () => {
    expect(isClaude(token)).toBe(true)
    expect(isOauth(token)).toBe(false)
  })

  test('needs no baseUrl or aliases, and keeps its sharing choice', () => {
    const p = validateProfile({ kind: 'claude-token', shareSessions: true }, 'test')
    expect(p.kind).toBe('claude-token')
    expect(p.shareSessions).toBe(true)
    expect(p.baseUrl).toBe('')
  })

  test('/login profiles still refuse sharing', () => {
    expect(() => validateProfile({ kind: 'oauth', shareSessions: true }, 'test')).toThrow(ProfileError)
  })

  test('survives a store round trip', () => {
    const store = validateStore({ version: 1, providers: { me: { kind: 'claude-token' }, work: { kind: 'oauth' } } })
    expect(store.providers.me!.kind).toBe('claude-token')
  })

  test('follows the global default, and an override of its own beats it', () => {
    expect(sharesSessions(token, on)).toBe(true)
    expect(sharesSessions(token, off)).toBe(false)
    expect(sharesSessions({ ...token, shareSessions: false }, on)).toBe(false)
    expect(sharesSessions({ ...token, shareSessions: true }, off)).toBe(true)
  })

  test('describeShare does not say it never shares', () => {
    expect(describeShare(token, off)).not.toContain('never')
  })

  test('applyProfileShare sets an override on it', () => {
    saveStore(paths, { version: 1, providers: { me: token } })
    expect(applyProfileShare(paths, 'me', true).changed).toBe(true)
    expect(loadStore(paths).providers.me!.shareSessions).toBe(true)
  })
})

describe('claude-token doctor', () => {
  test('fails without a stored token and has no endpoint or tier checks', async () => {
    const checks = await runDoctor('me', token, paths, new MemoryStore(), { env: { PATH: '/usr/bin' } })
    expect(checks.find((c) => c.label.startsWith('Claude token'))!.status).toBe('fail')
    expect(checks.map((c) => c.label)).not.toContain('model tier mapping')
    expect(checks.map((c) => c.label)).not.toContain('endpoint format')
  })

  test('passes with a setup-token and warns about anything else', async () => {
    const good = new MemoryStore()
    await good.set('me', SECRET)
    expect((await runDoctor('me', token, paths, good, { env: { PATH: '/usr/bin' } })).find((c) => c.label.startsWith('Claude token'))!.status).toBe('ok')
    const odd = new MemoryStore()
    await odd.set('me', 'nope')
    expect((await runDoctor('me', token, paths, odd, { env: { PATH: '/usr/bin' } })).find((c) => c.label.startsWith('Claude token'))!.status).toBe('warn')
  })
})

describe('the default slot', () => {
  const glm: Profile = { baseUrl: 'https://api.z.ai/api/anthropic', aliases: { opus: 'glm-5.3', sonnet: 'glm-5.3', haiku: 'glm-5.2', subagent: 'glm-5.2' }, defaultModel: 'glm-5.3' }
  const launcher = ['/usr/bin/true']

  test('overwrites in place: one entry, the new secret, the sessions kept', async () => {
    const secrets = new MemoryStore()
    await saveDefaultSlot({ paths, secrets }, glm, 'glm-key', launcher)
    const dir = profileDir(paths, DEFAULT_SLOT)
    mkdirSync(join(dir, 'projects'), { recursive: true })
    writeFileSync(join(dir, 'projects', 'session.jsonl'), 'hi')

    const r = await saveDefaultSlot({ paths, secrets }, token, SECRET, launcher)
    expect(r.previous?.baseUrl).toBe(glm.baseUrl)
    expect(Object.keys(loadStore(paths).providers)).toEqual([DEFAULT_SLOT])
    expect(loadStore(paths).providers.default!.kind).toBe('claude-token')
    expect(await secrets.get(DEFAULT_SLOT)).toBe(SECRET)
    expect(readFileSync(join(dir, 'projects', 'session.jsonl'), 'utf8')).toBe('hi')
  })

  test('makes `claude` run the slot', async () => {
    const r = await saveDefaultSlot({ paths, secrets: new MemoryStore() }, glm, 'k', launcher)
    expect(r.shim.path).toBe(join(paths.defaultBinDir, 'claude'))
    expect(readFileSync(r.shim.path, 'utf8')).toContain('default')
  })

  test('switching to a /login profile moves the old key aside, and away from one sets its login aside', async () => {
    const secrets = new MemoryStore()
    await saveDefaultSlot({ paths, secrets }, glm, 'glm-key', launcher)
    await saveDefaultSlot({ paths, secrets }, { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude' }, null, launcher)
    // A /login stores no key, so none is left under the slot; the old one is kept as a stash.
    expect(await secrets.get(DEFAULT_SLOT)).toBeNull()
    expect(await secrets.get('default:custom')).toBe('glm-key') // a profile with no preset is filed as custom

    const credentials = join(profileDir(paths, DEFAULT_SLOT), '.credentials.json')
    mkdirSync(profileDir(paths, DEFAULT_SLOT), { recursive: true })
    writeFileSync(credentials, '{}')
    await saveDefaultSlot({ paths, secrets }, token, SECRET, launcher)
    // Not deleted: swapping back to it needs no new login.
    expect(existsSync(credentials)).toBe(false)
    expect(existsSync(join(profileDir(paths, DEFAULT_SLOT), '.credentials.stashed.json'))).toBe(true)
  })
})

describe('env for a subscription profile after a provider one', () => {
  test('unsets the provider variables an earlier eval left in the shell', async () => {
    const { formatEnv } = await import('../src/envformat.js')
    const out = formatEnv(buildEnv({ profile: token, configDir: null, apiKey: SECRET, baseEnv: {} }), 'sh')
    for (const v of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL']) {
      expect(out).toContain(`unset ${v}\n`)
    }
    expect(out).toContain('export CLAUDE_CODE_OAUTH_TOKEN=')
    expect(out).not.toContain('unset CLAUDE_CODE_OAUTH_TOKEN')
  })
})

describe('the default slot, safety', () => {
  const launcher = ['/usr/bin/true']
  const glm: Profile = { baseUrl: 'https://api.z.ai/api/anthropic', aliases: { opus: 'a', sonnet: 'a', haiku: 'a', subagent: 'a' }, defaultModel: 'a' }

  test('a foreign claude in the wrapper directory refuses before anything is overwritten', async () => {
    const secrets = new MemoryStore()
    await saveDefaultSlot({ paths, secrets }, glm, 'glm-key', launcher)
    rmSync(join(paths.defaultBinDir, 'claude'))
    writeFileSync(join(paths.defaultBinDir, 'claude'), '#!/bin/sh\necho mine\n', { mode: 0o755 })

    await expect(saveDefaultSlot({ paths, secrets }, token, SECRET, launcher)).rejects.toThrow(ProfileError)
    expect(loadStore(paths).providers.default!.kind).toBeUndefined()
    expect(await secrets.get(DEFAULT_SLOT)).toBe('glm-key')
  })
})

describe('the default slot, rollback and notes', () => {
  const launcher = ['/usr/bin/true']
  const glm: Profile = { baseUrl: 'https://api.z.ai/api/anthropic', aliases: { opus: 'a', sonnet: 'a', haiku: 'a', subagent: 'a' }, defaultModel: 'a' }
  const login: Profile = { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude' }

  test('a failed write puts the old key back, also when the new profile stores none', async () => {
    const secrets = new MemoryStore()
    await saveDefaultSlot({ paths, secrets }, glm, 'glm-key', launcher)
    // The profile store cannot be written: its temporary file's name is a directory.
    mkdirSync(`${paths.configFile}.tmp`)

    await expect(saveDefaultSlot({ paths, secrets }, login, null, launcher)).rejects.toThrow()
    expect(await secrets.get(DEFAULT_SLOT)).toBe('glm-key')
    expect(loadStore(paths).providers.default!.baseUrl).toBe(glm.baseUrl)
  })

  test('says so when a /login slot is replaced by another /login', async () => {
    const secrets = new MemoryStore()
    await saveDefaultSlot({ paths, secrets }, login, null, launcher)
    const r = await saveDefaultSlot({ paths, secrets }, login, null, launcher)
    expect(r.notes.join(' ')).toContain('still signed in')
  })

  test('an ordinary profile with a launcher keeps showing it in ls and doctor, only the slot is exempt', async () => {
    const { runDoctor: doctor } = await import('../src/doctor.js')
    await saveDefaultSlot({ paths, secrets: new MemoryStore() }, glm, 'k', launcher)
    const checks = await doctor('default', glm, paths, new MemoryStore(), { skipNetwork: true, env: { PATH: '/usr/bin' } })
    expect(checks.find((c) => c.label === 'command `claude`')).toBeDefined()
    const other = await doctor('glm', glm, paths, new MemoryStore(), { skipNetwork: true, env: { PATH: '/usr/bin' } })
    expect(other.find((c) => c.label === 'command `glm`')).toBeDefined()
  })
})

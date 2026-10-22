import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SLOT, dropSlotFile, forgetVariant, saveDefaultSlot, stashedKeys, useVariant } from '../src/defaultslot.js'
import { loadStore, saveStore, ProfileError } from '../src/profile.js'
import { slotChecks } from '../src/doctor.js'
import { profileDir, type Paths } from '../src/paths.js'
import { MemoryStore } from '../src/secrets/index.js'
import {
  epochAt, loadSlot, presetKey, restoreLogin, saveSlot, slotFilePath, slotInUse, stashLogin, validateSlot, variantAccount, type Epoch,
} from '../src/slot.js'
import type { Profile } from '../src/types.js'

let home: string
let paths: Paths
let secrets: MemoryStore
let clock: number
const launcher = ['/usr/bin/true']
const deps = () => ({ paths, secrets, now: () => clock })

const deepseek: Profile = {
  baseUrl: 'https://api.deepseek.com/anthropic',
  aliases: { opus: 'm', sonnet: 'm', haiku: 'f', subagent: 'f' },
  defaultModel: 'm',
  preset: 'deepseek',
}
const glm: Profile = { ...deepseek, baseUrl: 'https://api.z.ai/api/anthropic', preset: 'glm' }
const token: Profile = { kind: 'claude-token', baseUrl: '', aliases: {}, preset: 'claude-token' }
const login: Profile = { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude' }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-slot-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, 'config', 'providers.json'),
    settingsFile: join(home, 'config', 'settings.json'),
    dirsRoot: join(home, 'dirs'),
    cacheDir: join(home, 'cache'),
    binDir: join(home, 'bin'),
    defaultBinDir: join(home, 'default-bin'),
    usageDir: join(home, 'usage'),
  }
  secrets = new MemoryStore()
  clock = 1_000
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('the slot file', () => {
  test('files a variant under its provider, whatever the profile is called', () => {
    expect(presetKey(deepseek)).toBe('deepseek')
    expect(presetKey(token)).toBe('claude-token')
    expect(presetKey(login)).toBe('claude')
    expect(presetKey({ baseUrl: 'http://x', aliases: {} })).toBe('custom')
  })

  test('validates what it reads', () => {
    expect(validateSlot({ version: 1 })).toEqual({ version: 1, variants: {}, epochs: [] })
    expect(() => validateSlot({ version: 2 })).toThrow(ProfileError)
    expect(() => validateSlot({ version: 1, variants: { 'Bad Name': deepseek } })).toThrow(/not a valid variant name/)
    expect(() => validateSlot({ version: 1, variants: { x: { baseUrl: 'nope', aliases: {} } } })).toThrow(ProfileError)
    expect(() => validateSlot({ version: 1, epochs: [{ from: -1, preset: 'x', claude: false }] })).toThrow(/epoch/)
  })

  test('survives a round trip, with the epochs in time order', () => {
    saveSlot(paths, { version: 1, variants: { deepseek }, epochs: [{ from: 50, preset: 'b', claude: true }, { from: 0, preset: 'a', claude: false }] })
    const back = loadSlot(paths)
    expect(back.variants.deepseek!.baseUrl).toBe(deepseek.baseUrl)
    expect(back.epochs.map((e) => e.preset)).toEqual(['a', 'b'])
    expect(readFileSync(slotFilePath(paths), 'utf8').endsWith('\n')).toBe(true)
  })

  test('epochAt finds the stretch a moment falls in', () => {
    const epochs: Epoch[] = [{ from: 0, preset: 'a', claude: false }, { from: 100, preset: 'b', claude: true }]
    expect(epochAt(epochs, 0)?.preset).toBe('a')
    expect(epochAt(epochs, 99)?.preset).toBe('a')
    expect(epochAt(epochs, 100)?.preset).toBe('b')
    expect(epochAt([], 5)).toBeUndefined()
  })

  test('only a slot that has been used counts as one', () => {
    expect(slotInUse(paths)).toBe(false)
    saveSlot(paths, { version: 1, variants: {}, epochs: [] })
    expect(slotInUse(paths)).toBe(false)
    saveSlot(paths, { version: 1, variants: {}, epochs: [{ from: 0, preset: 'a', claude: false }] })
    expect(slotInUse(paths)).toBe(true)
  })
})

describe('saving the default keeps what it replaces', () => {
  test('the first save stashes nothing and opens the history', async () => {
    const r = await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    expect(r.previous).toBeNull()
    expect(r.stashed).toBeNull()
    expect(await secrets.get(DEFAULT_SLOT)).toBe('ds-key')
    expect(loadSlot(paths).epochs).toEqual([{ from: 0, preset: 'deepseek', claude: false }])
  })

  test('changing provider stashes the old one with its key and starts a new stretch', async () => {
    await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    clock = 5_000
    const r = await saveDefaultSlot(deps(), token, 'sk-ant-oat01-t', launcher)

    expect(r.stashed).toBe('deepseek')
    expect(await secrets.get(DEFAULT_SLOT)).toBe('sk-ant-oat01-t')
    expect(await secrets.get(variantAccount('deepseek'))).toBe('ds-key')
    expect(stashedKeys(paths)).toEqual(['deepseek'])
    expect(loadSlot(paths).epochs).toEqual([
      { from: 0, preset: 'deepseek', claude: false },
      { from: 5_000, preset: 'claude-token', claude: true },
    ])
    // The slot stays one profile; the stash is not a profile.
    expect(Object.keys(loadStore(paths).providers)).toEqual([DEFAULT_SLOT])
  })

  test('the same provider again replaces it: nothing stashed, no new stretch', async () => {
    await saveDefaultSlot(deps(), deepseek, 'old', launcher)
    clock = 9_000
    const r = await saveDefaultSlot(deps(), deepseek, 'new', launcher)
    expect(r.stashed).toBeNull()
    expect(stashedKeys(paths)).toEqual([])
    expect(await secrets.get(DEFAULT_SLOT)).toBe('new')
    expect(loadSlot(paths).epochs).toHaveLength(1)
  })

  test('a slot from before the file existed gets its first stretch from what it was', async () => {
    saveStore(paths, { version: 1, providers: { default: deepseek } })
    await secrets.set(DEFAULT_SLOT, 'ds-key')
    await saveDefaultSlot(deps(), token, 'sk-ant-oat01-t', launcher)
    expect(loadSlot(paths).epochs.map((e) => [e.from, e.preset])).toEqual([[0, 'deepseek'], [1_000, 'claude-token']])
  })

  test('becoming a provider that was stashed makes that stash stale, so it goes', async () => {
    await saveDefaultSlot(deps(), deepseek, 'ds-1', launcher)
    await saveDefaultSlot(deps(), token, 'tok', launcher)
    await saveDefaultSlot(deps(), deepseek, 'ds-2', launcher)
    expect(stashedKeys(paths)).toEqual(['claude-token'])
    expect(await secrets.get(variantAccount('deepseek'))).toBeNull()
    expect(await secrets.get(DEFAULT_SLOT)).toBe('ds-2')
  })
})

describe('swapping with default --use', () => {
  test('brings a stashed provider back with its key, and stashes the one it replaces', async () => {
    await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    await saveDefaultSlot(deps(), token, 'tok', launcher)

    const r = await useVariant(deps(), 'deepseek', launcher)
    expect(r.stashed).toBe('claude-token')
    expect(loadStore(paths).providers.default!.baseUrl).toBe(deepseek.baseUrl)
    expect(await secrets.get(DEFAULT_SLOT)).toBe('ds-key')
    expect(await secrets.get(variantAccount('claude-token'))).toBe('tok')
    expect(await secrets.get(variantAccount('deepseek'))).toBeNull()
    expect(stashedKeys(paths)).toEqual(['claude-token'])
  })

  test('a round trip leaves both keys where they were, and records each switch', async () => {
    await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    clock = 2_000
    await saveDefaultSlot(deps(), token, 'tok', launcher)
    clock = 3_000
    await useVariant(deps(), 'deepseek', launcher)
    clock = 4_000
    await useVariant(deps(), 'claude-token', launcher)
    expect(await secrets.get(DEFAULT_SLOT)).toBe('tok')
    expect(await secrets.get(variantAccount('deepseek'))).toBe('ds-key')
    expect(loadSlot(paths).epochs.map((e) => [e.from, e.preset])).toEqual([
      [0, 'deepseek'], [2_000, 'claude-token'], [3_000, 'deepseek'], [4_000, 'claude-token'],
    ])
  })

  test('says what is there when asked for something that is not', async () => {
    await expect(useVariant(deps(), 'glm', launcher)).rejects.toThrow(/nothing stashed/)
    await saveDefaultSlot(deps(), deepseek, 'k', launcher)
    await saveDefaultSlot(deps(), token, 't', launcher)
    await expect(useVariant(deps(), 'glm', launcher)).rejects.toThrow(/It has: deepseek/)
  })

  test('refuses, changing nothing, when the stashed key is gone', async () => {
    await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    await saveDefaultSlot(deps(), token, 'tok', launcher)
    await secrets.delete(variantAccount('deepseek'))
    await expect(useVariant(deps(), 'deepseek', launcher)).rejects.toThrow(/gone from the secret store/)
    expect(loadStore(paths).providers.default!.kind).toBe('claude-token')
    expect(await secrets.get(DEFAULT_SLOT)).toBe('tok')
  })

  test('forgetting drops the entry and its key', async () => {
    await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    await saveDefaultSlot(deps(), token, 'tok', launcher)
    await forgetVariant(deps(), 'deepseek')
    expect(stashedKeys(paths)).toEqual([])
    expect(await secrets.get(variantAccount('deepseek'))).toBeNull()
    await expect(forgetVariant(deps(), 'deepseek')).rejects.toThrow(/nothing stashed/)
  })

  test('removing the default takes every stashed key with it, even from a damaged file', async () => {
    await saveDefaultSlot(deps(), deepseek, 'a', launcher)
    await saveDefaultSlot(deps(), glm, 'b', launcher)
    await saveDefaultSlot(deps(), token, 'c', launcher)
    expect(stashedKeys(paths)).toEqual(['deepseek', 'glm'])
    await dropSlotFile(deps())
    expect(existsSync(slotFilePath(paths))).toBe(false)
    expect(await secrets.get(variantAccount('deepseek'))).toBeNull()
    expect(await secrets.get(variantAccount('glm'))).toBeNull()

    writeFileSync(slotFilePath(paths), '{ not json')
    const warnings = await dropSlotFile(deps())
    expect(existsSync(slotFilePath(paths))).toBe(false)
    expect(warnings.join(' ')).toContain('not valid JSON')
  })
})

describe('a /login subscription in the slot', () => {
  const credentials = () => join(profileDir(paths, DEFAULT_SLOT), '.credentials.json')
  const stashed = () => join(profileDir(paths, DEFAULT_SLOT), '.credentials.stashed.json')

  test('its login is set aside when the slot moves on, and comes back with it', async () => {
    await saveDefaultSlot(deps(), login, null, launcher)
    mkdirSync(profileDir(paths, DEFAULT_SLOT), { recursive: true })
    writeFileSync(credentials(), '{"login":"mine"}')

    await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    expect(existsSync(credentials())).toBe(false)
    expect(readFileSync(stashed(), 'utf8')).toBe('{"login":"mine"}')
    expect(stashedKeys(paths)).toEqual(['claude'])

    await useVariant(deps(), 'claude', launcher)
    expect(readFileSync(credentials(), 'utf8')).toBe('{"login":"mine"}')
    expect(existsSync(stashed())).toBe(false)
    expect(await secrets.get(DEFAULT_SLOT)).toBeNull() // a /login stores no key
  })

  test('a newer login is not overwritten by an old one coming back', () => {
    const dir = profileDir(paths, DEFAULT_SLOT)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.credentials.stashed.json'), 'old')
    writeFileSync(join(dir, '.credentials.json'), 'new')
    expect(restoreLogin(dir)).toBeNull()
    expect(readFileSync(join(dir, '.credentials.json'), 'utf8')).toBe('new')
    expect(stashLogin(join(home, 'nowhere'))).toBeNull()
  })
})

describe('a swap that fails half way is undone', () => {
  test('when the profile cannot be written, the keys and the stash are as they were', async () => {
    await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    mkdirSync(`${paths.configFile}.tmp`) // the profile store cannot be written

    await expect(saveDefaultSlot(deps(), token, 'tok', launcher)).rejects.toThrow()
    expect(await secrets.get(DEFAULT_SLOT)).toBe('ds-key')
    expect(await secrets.get(variantAccount('deepseek'))).toBeNull()
    expect(stashedKeys(paths)).toEqual([])
    expect(loadStore(paths).providers.default!.baseUrl).toBe(deepseek.baseUrl)
  })

  test('when the slot file cannot be written, the profile goes back too', async () => {
    await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    mkdirSync(`${slotFilePath(paths)}.tmp`) // the slot file cannot be written

    await expect(saveDefaultSlot(deps(), token, 'tok', launcher)).rejects.toThrow()
    expect(loadStore(paths).providers.default!.baseUrl).toBe(deepseek.baseUrl)
    expect(await secrets.get(DEFAULT_SLOT)).toBe('ds-key')
    expect(await secrets.get(variantAccount('deepseek'))).toBeNull()
    expect(loadSlot(paths).epochs).toHaveLength(1)
  })

  test('a failed first save leaves no slot file behind', async () => {
    mkdirSync(`${slotFilePath(paths)}.tmp`, { recursive: true })
    await expect(saveDefaultSlot(deps(), deepseek, 'k', launcher)).rejects.toThrow()
    expect(existsSync(slotFilePath(paths))).toBe(false)
    expect(await secrets.get(DEFAULT_SLOT)).toBeNull()
  })
})

describe('doctor on the slot', () => {
  test('nothing to say without a slot file', async () => {
    expect(await slotChecks(paths, secrets, [])).toEqual([])
  })

  test('each stashed key is checked, and a file without its profile is flagged', async () => {
    await saveDefaultSlot(deps(), deepseek, 'ds-key', launcher)
    await saveDefaultSlot(deps(), token, 'tok', launcher)
    const ok = await slotChecks(paths, secrets, [DEFAULT_SLOT])
    expect(ok.map((c) => c.status)).toEqual(['ok'])

    await secrets.delete(variantAccount('deepseek'))
    expect((await slotChecks(paths, secrets, [DEFAULT_SLOT]))[0]!.status).toBe('fail')
    expect((await slotChecks(paths, secrets, [])).some((c) => c.label === 'slot file' && c.status === 'warn')).toBe(true)

    writeFileSync(slotFilePath(paths), '{ not json')
    expect((await slotChecks(paths, secrets, [DEFAULT_SLOT]))[0]).toMatchObject({ label: 'slot file', status: 'fail' })
  })
})

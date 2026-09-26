import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameProfile, staleVirtualenvs } from '../src/rename.js'
import { loadStore, saveStore } from '../src/profile.js'
import { installShim, inspectShim } from '../src/shim.js'
import { MemoryStore, type SecretStore } from '../src/secrets/index.js'
import { profileDir, type Paths } from '../src/paths.js'
import type { Profile, ProfileStore } from '../src/types.js'

let home: string
let paths: Paths
let secrets: MemoryStore
let store: ProfileStore
const launcher = ['/opt/cc/ccprovider']

const profile = (url: string): Profile => ({
  baseUrl: url,
  aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' },
})

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-rename-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, '.config/ccprovider/providers.json'),
    dirsRoot: join(home, '.local/share/ccprovider/dirs'),
    cacheDir: join(home, '.cache/ccprovider'),
    binDir: join(home, 'bin'),
  }
  secrets = new MemoryStore()
  await secrets.set('zclaude', 'sk-secret')
  await secrets.set('other', 'sk-other')

  store = { version: 1, providers: { zclaude: profile('https://api.z.ai/api/anthropic'), other: profile('https://x.dev/anthropic') } }
  saveStore(paths, store)

  // A profile directory with session history, and a venv that embeds its own path.
  const dir = profileDir(paths, 'zclaude')
  mkdirSync(join(dir, 'security/venv'), { recursive: true })
  writeFileSync(join(dir, 'history.jsonl'), 'a session')
  writeFileSync(join(dir, 'security/venv/pyvenv.cfg'), `home = ${dir}/security/venv/bin\n`)
  installShim(paths, 'zclaude', launcher)
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const deps = (over: Partial<Parameters<typeof renameProfile>[0]> = {}) => ({ paths, secrets, store, launcher, ...over })

/** Everything a failed rename must leave exactly as it found it. */
async function expectUntouched() {
  expect(Object.keys(loadStore(paths).providers)).toEqual(['zclaude', 'other'])
  expect(await secrets.get('zclaude')).toBe('sk-secret')
  expect(readFileSync(join(profileDir(paths, 'zclaude'), 'history.jsonl'), 'utf8')).toBe('a session')
  expect(inspectShim(paths, 'zclaude', { PATH: '' }).state).toBe('ours')
}

describe('renameProfile', () => {
  test('moves the store entry, directory, key and command together', async () => {
    const r = await renameProfile(deps(), 'zclaude', 'glm')

    expect(r.command).toBe('moved')
    expect(r.warnings).toEqual([])

    // store: renamed in place — order preserved — and persisted, not just in memory
    expect(Object.keys(loadStore(paths).providers)).toEqual(['glm', 'other'])
    expect(Object.keys(store.providers)).toEqual(['glm', 'other'])

    // directory and its session history
    expect(existsSync(profileDir(paths, 'zclaude'))).toBe(false)
    expect(readFileSync(join(profileDir(paths, 'glm'), 'history.jsonl'), 'utf8')).toBe('a session')

    // key
    expect(await secrets.get('glm')).toBe('sk-secret')
    expect(await secrets.get('zclaude')).toBeNull()
    expect(await secrets.get('other')).toBe('sk-other')

    // command
    expect(inspectShim(paths, 'glm', { PATH: '' }).state).toBe('ours')
    expect(inspectShim(paths, 'zclaude', { PATH: '' }).state).toBe('absent')
  })

  test('the new command execs the new name', async () => {
    await renameProfile(deps(), 'zclaude', 'glm')
    expect(readFileSync(join(paths.binDir, 'glm'), 'utf8')).toContain(`use 'glm' --`)
  })

  test('does not invent a command for a profile that never had one', async () => {
    rmSync(join(paths.binDir, 'zclaude'))
    const r = await renameProfile(deps(), 'zclaude', 'glm')
    expect(r.command).toBe('none')
    expect(existsSync(join(paths.binDir, 'glm'))).toBe(false)
  })

  test('a profile with no stored key still renames, and creates no key', async () => {
    await secrets.delete('zclaude')
    await renameProfile(deps(), 'zclaude', 'glm')
    expect(await secrets.get('glm')).toBeNull()
  })

  test('reports virtualenvs that still point at the old directory', async () => {
    const r = await renameProfile(deps(), 'zclaude', 'glm')
    expect(r.staleVenvs).toEqual([join(profileDir(paths, 'glm'), 'security/venv')])
  })

  test('is case-insensitive about the new name, like every other entry point', async () => {
    await renameProfile(deps(), 'ZClaude', 'GLM')
    expect(Object.keys(loadStore(paths).providers)).toContain('glm')
  })
})

describe('preflight refusals change nothing', () => {
  test.each([
    ['an unknown profile', 'ghost', 'glm', /No profile named "ghost"/],
    ['the same name', 'zclaude', 'zclaude', /already called that/],
    ['a name another profile has', 'zclaude', 'other', /already exists/],
    ['an invalid name', 'zclaude', '../evil', /not a valid profile name/],
    ['a name that cannot be a command', 'zclaude', 'claude', /cannot be installed as a command/],
  ])('%s', async (_label, from, to, message) => {
    await expect(renameProfile(deps(), from, to)).rejects.toThrow(message as RegExp)
    await expectUntouched()
  })

  test('a leftover directory at the target', async () => {
    mkdirSync(profileDir(paths, 'glm'), { recursive: true })
    await expect(renameProfile(deps(), 'zclaude', 'glm')).rejects.toThrow(/already exists/)
    await expectUntouched()
  })

  test('a dangling symlink at the target still counts as occupied', async () => {
    mkdirSync(paths.dirsRoot, { recursive: true })
    symlinkSync(join(home, 'nowhere'), profileDir(paths, 'glm'))
    await expect(renameProfile(deps(), 'zclaude', 'glm')).rejects.toThrow(/already exists/)
    expect(lstatSync(profileDir(paths, 'glm')).isSymbolicLink()).toBe(true)
    await expectUntouched()
  })

  test('an orphaned key already stored under the target name', async () => {
    await secrets.set('glm', 'orphan')
    await expect(renameProfile(deps(), 'zclaude', 'glm')).rejects.toThrow(/already holds a different key/)
    expect(await secrets.get('glm')).toBe('orphan')
    await expectUntouched()
  })

  test('someone else’s program already has the command name', async () => {
    mkdirSync(paths.binDir, { recursive: true })
    writeFileSync(join(paths.binDir, 'glm'), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    await expect(renameProfile(deps(), 'zclaude', 'glm')).rejects.toThrow(/not one of ccprovider's launchers/)
    expect(readFileSync(join(paths.binDir, 'glm'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
    await expectUntouched()
  })

  test('the refusal for a foreign key tells the user how to clear it', async () => {
    await secrets.set('glm', 'orphan')
    await expect(renameProfile(deps(), 'zclaude', 'glm')).rejects.toThrow(/security delete-generic-password -s ccprovider -a glm/)
  })

  test('an interrupted earlier rename is recognised and the user is told where their history is', async () => {
    // Regression: killed between moving the directory and saving the config, the history sits
    // under the new name while the old profile has no directory. The old message said "left
    // over from a deleted profile — move it aside", which would have stranded the history.
    const { renameSync } = await import('node:fs')
    renameSync(profileDir(paths, 'zclaude'), profileDir(paths, 'glm'))

    const err = await renameProfile(deps(), 'zclaude', 'glm').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('interrupted')
    expect((err as Error).message).toContain(`mv '${profileDir(paths, 'glm')}' '${profileDir(paths, 'zclaude')}'`)
  })

  test('a genuine leftover directory (the old profile still has its own) keeps the "move it aside" advice', async () => {
    mkdirSync(profileDir(paths, 'glm'), { recursive: true })
    await expect(renameProfile(deps(), 'zclaude', 'glm')).rejects.toThrow(/left over from a deleted profile\?\)\. Move it aside first/)
  })

  test('an unreadable key aborts before anything moves', async () => {
    const broken: SecretStore = {
      name: 'broken',
      get: async () => { throw new Error('keychain locked') },
      set: async () => {},
      delete: async () => {},
    }
    await expect(renameProfile(deps({ secrets: broken }), 'zclaude', 'glm')).rejects.toThrow(/keychain locked/)
    expect(existsSync(profileDir(paths, 'zclaude'))).toBe(true)
    expect(existsSync(profileDir(paths, 'glm'))).toBe(false)
  })
})

describe('resuming', () => {
  test('the same key already filed under the new name (an earlier attempt copied it) is accepted', async () => {
    await secrets.set('glm', 'sk-secret')
    const r = await renameProfile(deps(), 'zclaude', 'glm')
    expect(r.warnings).toEqual([])
    expect(await secrets.get('glm')).toBe('sk-secret')
    expect(await secrets.get('zclaude')).toBeNull()
  })
})

describe('rollback', () => {
  test('a failure at the commit point restores every earlier step', async () => {
    // Regression guard: without the undo stack this leaves the key, the directory and a
    // launcher all under the new name while providers.json still names the old one.
    const save = () => { throw new Error('disk full') }
    await expect(renameProfile(deps({ save }), 'zclaude', 'glm')).rejects.toThrow(/disk full.*Nothing was changed/)

    await expectUntouched()
    expect(await secrets.get('glm')).toBeNull()
    expect(existsSync(profileDir(paths, 'glm'))).toBe(false)
    expect(existsSync(join(paths.binDir, 'glm'))).toBe(false)
    expect(Object.keys(store.providers)).toEqual(['zclaude', 'other']) // caller's copy untouched too
  })

  test('a failure storing the new key moves nothing', async () => {
    const failing: SecretStore = {
      name: 'failing',
      get: (a) => secrets.get(a),
      set: async () => { throw new Error('keychain denied') },
      delete: (a) => secrets.delete(a),
    }
    await expect(renameProfile(deps({ secrets: failing }), 'zclaude', 'glm')).rejects.toThrow(/keychain denied.*Nothing was changed/)
    await expectUntouched()
    expect(existsSync(profileDir(paths, 'glm'))).toBe(false)
  })

  test('says so when the undo itself cannot finish', async () => {
    const flaky: SecretStore = {
      name: 'flaky',
      get: (a) => secrets.get(a),
      set: (a, s) => secrets.set(a, s),
      delete: async () => { throw new Error('cannot delete') },
    }
    const save = () => { throw new Error('disk full') }
    await expect(renameProfile(deps({ secrets: flaky, save }), 'zclaude', 'glm')).rejects.toThrow(/Undoing it also failed \(cannot delete\)/)
  })
})

describe('after the commit', () => {
  test('a key that cannot be deleted from the old account is a warning, not a failure', async () => {
    const stubborn: SecretStore = {
      name: 'stubborn',
      get: (a) => secrets.get(a),
      set: (a, s) => secrets.set(a, s),
      delete: async () => { throw new Error('denied') },
    }
    const r = await renameProfile(deps({ secrets: stubborn }), 'zclaude', 'glm')
    expect(r.warnings.join('\n')).toContain('"zclaude" is still in the secret store')
    expect(Object.keys(loadStore(paths).providers)).toEqual(['glm', 'other']) // it did commit
    expect(await secrets.get('glm')).toBe('sk-secret')
  })
})

describe('staleVirtualenvs', () => {
  test('does not look inside symlinks (shared plugins) or session data', () => {
    const root = join(home, 'prof')
    const shared = join(home, 'shared-plugins')
    mkdirSync(join(shared, 'venv'), { recursive: true })
    writeFileSync(join(shared, 'venv/pyvenv.cfg'), `home = ${root}\n`)
    mkdirSync(root)
    symlinkSync(shared, join(root, 'plugins'))
    mkdirSync(join(root, 'projects/p/venv'), { recursive: true })
    writeFileSync(join(root, 'projects/p/venv/pyvenv.cfg'), `home = ${root}\n`)

    expect(staleVirtualenvs(root, root)).toEqual([])
  })

  test('ignores a venv that does not mention the old directory', () => {
    const root = join(home, 'prof')
    mkdirSync(join(root, 'v'), { recursive: true })
    writeFileSync(join(root, 'v/pyvenv.cfg'), 'home = /somewhere/else\n')
    expect(staleVirtualenvs(root, '/old/dir')).toEqual([])
  })
})

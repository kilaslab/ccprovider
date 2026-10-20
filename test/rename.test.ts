import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameProfile, staleVirtualenvs } from '../src/rename.js'
import { emptyLedger, ledgerPath, loadLedger, saveLedger } from '../src/usage.js'
import { copyFileSync } from 'node:fs'
import { loadStore, saveStore } from '../src/profile.js'
import { inspectDefaultShim, installDefaultShim, installShim, inspectShim } from '../src/shim.js'
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
    settingsFile: join(home, '.config/ccprovider/settings.json'),
    dirsRoot: join(home, '.local/share/ccprovider/dirs'),
    cacheDir: join(home, '.cache/ccprovider'),
    binDir: join(home, 'bin'),
    defaultBinDir: join(home, 'default-bin'),
    usageDir: join(home, 'usage'),
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

describe('the default `claude` wrapper', () => {
  const runs = () => inspectDefaultShim(paths, { PATH: '' }).profile

  test('follows the profile it runs to its new name', async () => {
    installDefaultShim(paths, 'zclaude', launcher)
    const r = await renameProfile(deps(), 'zclaude', 'glm')
    expect(r.defaultCommand).toBe('moved')
    expect(runs()).toBe('glm')
  })

  test('is left alone when it runs another profile, and when there is none', async () => {
    installDefaultShim(paths, 'other', launcher)
    const r = await renameProfile(deps(), 'zclaude', 'glm')
    expect(r.defaultCommand).toBeUndefined()
    expect(runs()).toBe('other')
  })

  test('is left alone when the claude there is not ours', async () => {
    mkdirSync(paths.defaultBinDir, { recursive: true })
    writeFileSync(join(paths.defaultBinDir, 'claude'), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    await renameProfile(deps(), 'zclaude', 'glm')
    expect(readFileSync(join(paths.defaultBinDir, 'claude'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })

  // The wrapper changes before the commit point, so a failure there must put it back:
  // otherwise `claude` would run a profile that the config still calls something else.
  // Undoing must put the wrapper back as it was, not rewrite it for whatever ccprovider ran the rename.
  test('goes back with the launcher it had, not the one that ran the failed rename', async () => {
    installDefaultShim(paths, 'zclaude', ['/older/nvm/ccprovider'])
    await expect(renameProfile(deps({ save: () => { throw new Error('disk full') } }), 'zclaude', 'glm')).rejects.toThrow(/disk full/)
    expect(inspectDefaultShim(paths, { PATH: '' }).launcher).toEqual(['/older/nvm/ccprovider'])
  })

  test('goes back to the old name when the rename fails at the commit point', async () => {
    installDefaultShim(paths, 'zclaude', launcher)
    await expect(renameProfile(deps({ save: () => { throw new Error('disk full') } }), 'zclaude', 'glm')).rejects.toThrow(/disk full/)
    expect(runs()).toBe('zclaude')
    await expectUntouched()
  })
})

describe('the usage ledger', () => {
  const ledgerWith = () => {
    const l = emptyLedger()
    l.calls.msg_1 = ['glm-5.3', 1_700_000_000, 10, 5, null, null]
    return l
  }

  test('moves with the profile, so its history of use is not orphaned', async () => {
    saveLedger(ledgerPath(paths, 'zclaude'), ledgerWith())
    await renameProfile(deps(), 'zclaude', 'glm')
    expect(existsSync(ledgerPath(paths, 'zclaude'))).toBe(false)
    expect(loadLedger(ledgerPath(paths, 'glm'))?.calls.msg_1).toBeDefined()
  })

  test('takes the copy a --rebuild left behind along with it', async () => {
    saveLedger(ledgerPath(paths, 'zclaude'), ledgerWith())
    copyFileSync(ledgerPath(paths, 'zclaude'), `${ledgerPath(paths, 'zclaude')}.bak`)
    await renameProfile(deps(), 'zclaude', 'glm')
    expect(existsSync(`${ledgerPath(paths, 'zclaude')}.bak`)).toBe(false)
    expect(existsSync(`${ledgerPath(paths, 'glm')}.bak`)).toBe(true)
  })

  // Usage already filed under the new name is either a deleted profile's, which this one must
  // not inherit, or what an interrupted rename of this very profile left. Nothing tells the two
  // apart, so neither is guessed: the rename stops and says how to resolve it, as it does for
  // the profile directory.
  test('stops, saying why, when anything is already filed under the new name', async () => {
    mkdirSync(paths.usageDir, { recursive: true })
    for (const leftover of ['', '.bak', '.damaged']) {
      writeFileSync(`${ledgerPath(paths, 'glm')}${leftover}`, 'old')
      await expect(renameProfile(deps(), 'zclaude', 'glm')).rejects.toThrow(/interrupted|left over/)
      await expectUntouched()
      rmSync(`${ledgerPath(paths, 'glm')}${leftover}`)
    }
  })

  test('also when the profile being renamed has no usage of its own', async () => {
    mkdirSync(paths.usageDir, { recursive: true })
    writeFileSync(ledgerPath(paths, 'glm'), 'old')
    await expect(renameProfile(deps(), 'zclaude', 'glm')).rejects.toThrow(/glm\.json/)
  })

  test('a profile that never had one renames without inventing it', async () => {
    await renameProfile(deps(), 'zclaude', 'glm')
    expect(existsSync(ledgerPath(paths, 'glm'))).toBe(false)
  })

  test('goes back to the old name when the rename fails at the commit point', async () => {
    saveLedger(ledgerPath(paths, 'zclaude'), ledgerWith())
    await expect(renameProfile(deps({ save: () => { throw new Error('disk full') } }), 'zclaude', 'glm')).rejects.toThrow(/disk full/)
    expect(loadLedger(ledgerPath(paths, 'zclaude'))?.calls.msg_1).toBeDefined()
    expect(existsSync(ledgerPath(paths, 'glm'))).toBe(false)
  })

  test('refuses before moving anything when the new name already has one', async () => {
    saveLedger(ledgerPath(paths, 'zclaude'), ledgerWith())
    saveLedger(ledgerPath(paths, 'glm'), emptyLedger())
    await expect(renameProfile(deps(), 'zclaude', 'glm')).rejects.toThrow(/usage/)
    await expectUntouched()
  })
})

describe('a new name every object already has', () => {
  test('is not "already taken"', async () => {
    await renameProfile(deps(), 'zclaude', 'constructor')
    expect(Object.keys(loadStore(paths).providers)).toEqual(['constructor', 'other'])
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

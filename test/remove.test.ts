import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeProfile } from '../src/remove.js'
import { loadStore, saveStore } from '../src/profile.js'
import { installShim } from '../src/shim.js'
import { MemoryStore } from '../src/secrets/index.js'
import { reconcileLinks } from '../src/configdir.js'
import { profileDir, type Paths } from '../src/paths.js'
import type { ProfileStore } from '../src/types.js'

let home: string
let paths: Paths
let secrets: MemoryStore
let store: ProfileStore

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-remove-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, '.config/ccprovider/providers.json'),
    dirsRoot: join(home, '.local/share/ccprovider/dirs'),
    cacheDir: join(home, '.cache/ccprovider'),
    binDir: join(home, 'bin'),
  }
  mkdirSync(join(paths.claudeDir, 'skills'), { recursive: true })
  writeFileSync(join(paths.claudeDir, 'skills', 'keep.md'), 'shared skill')
  secrets = new MemoryStore()
  await secrets.set('glm', 'sk-glm')
  store = {
    version: 1,
    providers: {
      glm: { baseUrl: 'https://api.z.ai/api/anthropic', aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' } },
      other: { baseUrl: 'https://x.dev/anthropic', aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' } },
    },
  }
  saveStore(paths, store)
  reconcileLinks(profileDir(paths, 'glm'), paths.claudeDir)
  writeFileSync(join(profileDir(paths, 'glm'), 'history.jsonl'), 'history')
  installShim(paths, 'glm', ['/opt/cc/ccprovider'])
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('removeProfile', () => {
  test('takes the profile, its directory, its key and its command — nothing else', async () => {
    const r = await removeProfile({ paths, secrets, store }, 'glm')
    expect(r).toEqual({ command: 'removed', warnings: [] })
    expect(Object.keys(loadStore(paths).providers)).toEqual(['other'])
    expect(existsSync(profileDir(paths, 'glm'))).toBe(false)
    expect(await secrets.get('glm')).toBeNull()
    expect(existsSync(join(paths.binDir, 'glm'))).toBe(false)
    expect(readFileSync(join(paths.claudeDir, 'skills', 'keep.md'), 'utf8')).toBe('shared skill')
  })

  test('a command of the same name that ccprovider did not write is left alone', async () => {
    rmSync(join(paths.binDir, 'glm'))
    writeFileSync(join(paths.binDir, 'glm'), '#!/bin/sh\necho not ours\n', { mode: 0o755 })
    expect((await removeProfile({ paths, secrets, store }, 'glm')).command).toBe('foreign')
    expect(readFileSync(join(paths.binDir, 'glm'), 'utf8')).toContain('not ours')
  })

  test('a key that cannot be deleted does not keep the profile around', async () => {
    const stuck = Object.assign(new MemoryStore(), { delete: async () => { throw new Error('denied') } })
    const r = await removeProfile({ paths, secrets: stuck, store }, 'glm')
    expect(loadStore(paths).providers.glm).toBeUndefined()
    expect(r.warnings[0]).toContain('denied')
  })
})

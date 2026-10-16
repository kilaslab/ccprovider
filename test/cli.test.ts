import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPaths, type Paths } from '../src/paths.js'
import { loadStore, saveStore } from '../src/profile.js'
import { installShim } from '../src/shim.js'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')

let home: string
let env: Record<string, string>
let paths: Paths

/** The real CLI, in a throwaway home. */
const run = (...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
  return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '') }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-cli-'))
  env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_CACHE_HOME: join(home, 'cache'),
    CCPROVIDER_BIN_DIR: join(home, 'bin'),
    CCPROVIDER_SECRET_BACKEND: 'file',
    CLAUDE_CONFIG_DIR: join(home, '.claude'),
  }
  paths = getPaths(env, home)
  saveStore(paths, {
    version: 1,
    providers: { glm: { baseUrl: 'https://api.z.ai/api/anthropic', aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' } } },
  })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('deleting a profile', () => {
  test('`delete` is `rm` — the word people reach for first', () => {
    const r = run('delete', 'glm', '-y')
    expect(r.status).toBe(0)
    expect(loadStore(paths).providers.glm).toBeUndefined()
  })
})

describe('uninstall', () => {
  test('says the profile is still there, and how to delete it or get the command back', () => {
    installShim(paths, 'glm', ['/opt/cc/ccprovider'])
    const r = run('uninstall', 'glm')
    expect(r.status).toBe(0)
    expect(r.out).toContain('Removed the `glm` command.')
    expect(r.out).toContain('ccprovider rm glm')
    expect(r.out).toContain('ccprovider install glm')
    expect(loadStore(paths).providers.glm).toBeDefined()
  })

  test('says nothing more for a name with no profile behind it', () => {
    installShim(paths, 'orphan', ['/opt/cc/ccprovider'])
    expect(run('uninstall', 'orphan').out).not.toContain('ccprovider rm')
  })
})


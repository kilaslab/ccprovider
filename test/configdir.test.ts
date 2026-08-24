import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectLinks, reconcileLinks, removeProfileDir, LINKED_ENTRIES } from '../src/configdir.js'
import { getPaths, profileDir, isInside } from '../src/paths.js'

let home: string
let claudeDir: string
let dirsRoot: string
let dir: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-test-'))
  claudeDir = join(home, '.claude')
  dirsRoot = join(home, '.local/share/ccprovider/dirs')
  dir = join(dirsRoot, 'deepseek')

  // A populated, realistic ~/.claude
  mkdirSync(join(claudeDir, 'skills', 'graphify'), { recursive: true })
  writeFileSync(join(claudeDir, 'skills', 'graphify', 'SKILL.md'), 'precious user content')
  mkdirSync(join(claudeDir, 'plugins', 'marketplaces'), { recursive: true })
  writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), '{"a":1}')
  mkdirSync(join(claudeDir, 'rules'), { recursive: true })
  writeFileSync(join(claudeDir, 'rules', 'context7.md'), 'rule')
  writeFileSync(join(claudeDir, 'CLAUDE.md'), '# global instructions')
  writeFileSync(join(claudeDir, 'settings.json'), '{"theme":"dark"}')
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('reconcileLinks', () => {
  test('links every entry that exists in the source', () => {
    const results = reconcileLinks(dir, claudeDir)
    for (const entry of ['skills', 'plugins', 'rules', 'CLAUDE.md', 'settings.json']) {
      expect(lstatSync(join(dir, entry)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(dir, entry))).toBe(join(claudeDir, entry))
    }
    expect(results.filter((r) => r.action === 'created')).toHaveLength(5)
  })

  test('entries absent from the source are not linked', () => {
    reconcileLinks(dir, claudeDir)
    expect(existsSync(join(dir, 'agents'))).toBe(false)
    expect(existsSync(join(dir, 'commands'))).toBe(false)
  })

  test('an entry added to ~/.claude later gets linked on the next run', () => {
    reconcileLinks(dir, claudeDir)
    mkdirSync(join(claudeDir, 'agents'))
    const results = reconcileLinks(dir, claudeDir)
    expect(results.find((r) => r.entry === 'agents')?.action).toBe('created')
    expect(readlinkSync(join(dir, 'agents'))).toBe(join(claudeDir, 'agents'))
  })

  test('is idempotent — a second run reports everything already ok', () => {
    reconcileLinks(dir, claudeDir)
    const results = reconcileLinks(dir, claudeDir)
    expect(results.every((r) => r.action === 'ok')).toBe(true)
  })

  test('repairs a link pointing at the wrong place', () => {
    mkdirSync(dir, { recursive: true })
    symlinkSync(join(home, 'somewhere-else'), join(dir, 'skills'))
    const results = reconcileLinks(dir, claudeDir)
    expect(results.find((r) => r.entry === 'skills')?.action).toBe('repaired')
    expect(readlinkSync(join(dir, 'skills'))).toBe(join(claudeDir, 'skills'))
  })

  test('drops a dangling link when the source disappears', () => {
    reconcileLinks(dir, claudeDir)
    rmSync(join(claudeDir, 'rules'), { recursive: true })
    const results = reconcileLinks(dir, claudeDir)
    expect(results.find((r) => r.entry === 'rules')?.action).toBe('removed-dangling')
    expect(existsSync(join(dir, 'rules'))).toBe(false)
  })

  test('refuses to clobber a real directory sitting where a link belongs', () => {
    mkdirSync(join(dir, 'skills'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'mine.md'), 'hand-placed')
    const results = reconcileLinks(dir, claudeDir)
    expect(results.find((r) => r.entry === 'skills')?.action).toBe('skipped-real')
    expect(readFileSync(join(dir, 'skills', 'mine.md'), 'utf8')).toBe('hand-placed')
  })
})

describe('removeProfileDir — must never follow a link out of the profile', () => {
  test('THE SAFETY TEST: removing a profile leaves the real ~/.claude fully intact', () => {
    reconcileLinks(dir, claudeDir)

    // realistic per-profile state alongside the links
    mkdirSync(join(dir, 'sessions'), { recursive: true })
    writeFileSync(join(dir, 'sessions', 's1.jsonl'), 'session')
    writeFileSync(join(dir, 'history.jsonl'), 'history')

    removeProfileDir(dir, dirsRoot)

    expect(existsSync(dir)).toBe(false)

    // every byte of the real config survives
    expect(readFileSync(join(claudeDir, 'skills', 'graphify', 'SKILL.md'), 'utf8')).toBe('precious user content')
    expect(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).toBe('{"a":1}')
    expect(readFileSync(join(claudeDir, 'rules', 'context7.md'), 'utf8')).toBe('rule')
    expect(readFileSync(join(claudeDir, 'CLAUDE.md'), 'utf8')).toBe('# global instructions')
    expect(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}')
    expect(existsSync(join(claudeDir, 'plugins', 'marketplaces'))).toBe(true)
  })

  test('refuses to remove anything outside the profile root', () => {
    expect(() => removeProfileDir(claudeDir, dirsRoot)).toThrow(/outside the ccprovider profile root/)
    expect(() => removeProfileDir(home, dirsRoot)).toThrow()
    expect(existsSync(claudeDir)).toBe(true)
  })

  test('refuses to remove the profile root itself', () => {
    mkdirSync(dirsRoot, { recursive: true })
    expect(() => removeProfileDir(dirsRoot, dirsRoot)).toThrow()
    expect(existsSync(dirsRoot)).toBe(true)
  })

  test('is a no-op on a profile that was never created', () => {
    expect(() => removeProfileDir(join(dirsRoot, 'ghost'), dirsRoot)).not.toThrow()
  })
})

describe('inspectLinks', () => {
  test('reports targets and flags broken links', () => {
    reconcileLinks(dir, claudeDir)
    rmSync(join(claudeDir, 'CLAUDE.md'))
    const rows = inspectLinks(dir)
    expect(rows.find((r) => r.entry === 'skills')?.broken).toBe(false)
    expect(rows.find((r) => r.entry === 'CLAUDE.md')?.broken).toBe(true)
    expect(rows.find((r) => r.entry === 'agents')?.target).toBeNull()
  })
})

describe('paths', () => {
  test('respects XDG overrides', () => {
    const p = getPaths({ XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data' }, '/h')
    expect(p.configFile).toBe('/x/cfg/ccprovider/providers.json')
    expect(p.dirsRoot).toBe('/x/data/ccprovider/dirs')
  })

  test('falls back to ~/.claude when CLAUDE_CONFIG_DIR points into a profile', () => {
    // i.e. ccprovider run from inside a session ccprovider itself launched
    const inner = '/h/.local/share/ccprovider/dirs/deepseek'
    expect(getPaths({ CLAUDE_CONFIG_DIR: inner }, '/h').claudeDir).toBe('/h/.claude')
  })

  test('honours a genuine external CLAUDE_CONFIG_DIR', () => {
    expect(getPaths({ CLAUDE_CONFIG_DIR: '/opt/claude' }, '/h').claudeDir).toBe('/opt/claude')
  })

  test('isInside is not fooled by a shared prefix', () => {
    expect(isInside('/a/bc', '/a/b')).toBe(false)
    expect(isInside('/a/b/c', '/a/b')).toBe(true)
  })

  test('profileDir composes under the data root', () => {
    const p = getPaths({ XDG_DATA_HOME: '/x/data' }, '/h')
    expect(profileDir(p, 'deepseek')).toBe('/x/data/ccprovider/dirs/deepseek')
  })
})

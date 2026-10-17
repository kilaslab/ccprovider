import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  commandName,
  findOnPath,
  inspectDefaultShim,
  installDefaultShim,
  isDefaultWrapper,
  installShim,
  listShims,
  removeDefaultShim,
  renderShim,
} from '../src/shim.js'
import { ProfileError } from '../src/profile.js'
import type { Paths } from '../src/paths.js'

let home: string
let paths: Paths
let fake: string // a stand-in for ccprovider that records how it was called
let argsOut: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-default-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, '.config/ccprovider/providers.json'),
    dirsRoot: join(home, '.local/share/ccprovider/dirs'),
    cacheDir: join(home, '.cache/ccprovider'),
    binDir: join(home, 'bin'),
    defaultBinDir: join(home, '.local/share/ccprovider/bin'),
    usageDir: join(home, '.local/share/ccprovider/usage'),
  }
  argsOut = join(home, 'args.out')
  fake = join(home, 'fake-ccprovider')
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsOut}'\nexit 7\n`, { mode: 0o755 })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const recorded = () => readFileSync(argsOut, 'utf8').split('\0').slice(0, -1)
const wrapper = () => join(paths.defaultBinDir, 'claude')

/** A directory holding an executable `claude` that says who it is. */
function claudeIn(dir: string, says: string): string {
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'claude')
  writeFileSync(p, `#!/bin/sh\necho ${says}\n`, { mode: 0o755 })
  return p
}

describe('the default `claude` wrapper', () => {
  test('is named claude, lives in its own directory, and carries its own marker', () => {
    const r = installDefaultShim(paths, 'glm', [fake])
    expect(r).toEqual({ path: wrapper(), action: 'created' })
    expect(readFileSync(wrapper(), 'utf8')).toBe(
      [
        '#!/bin/sh',
        '# ccprovider-default profile=glm - managed by ccprovider, do not edit',
        `exec '${fake}' use 'glm' --from-default -- "$@"`,
        '',
      ].join('\n'),
    )
    expect(readdirSync(paths.defaultBinDir)).toEqual(['claude'])
    expect(existsSync(join(paths.binDir, 'claude'))).toBe(false)
  })

  test('hands every argument to `use <profile> --` untouched, and returns the exit code', () => {
    installDefaultShim(paths, 'glm', [fake])
    const hostile = ['a b', "it's", '$(touch PWNED)', '--help', '-m', 'opus', '-y', '--resume']
    const r = spawnSync(wrapper(), hostile, { cwd: home })
    expect(r.status).toBe(7)
    expect(recorded()).toEqual(['use', 'glm', '--from-default', '--', ...hostile])
    expect(existsSync(join(home, 'PWNED'))).toBe(false)
  })

  test('switching profile rewrites it in place; repeating the same call changes nothing', () => {
    installDefaultShim(paths, 'glm', [fake])
    expect(installDefaultShim(paths, 'glm', [fake]).action).toBe('unchanged')
    expect(installDefaultShim(paths, 'kimi', [fake]).action).toBe('updated')
    expect(inspectDefaultShim(paths, {}).profile).toBe('kimi')
  })

  test('never overwrites a claude it did not write', () => {
    mkdirSync(paths.defaultBinDir, { recursive: true })
    writeFileSync(wrapper(), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    expect(() => installDefaultShim(paths, 'glm', [fake])).toThrow(ProfileError)
    expect(readFileSync(wrapper(), 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })

  test('never follows a symlink, which is what Claude Code installs itself as', () => {
    const real = claudeIn(join(home, 'versions'), 'real')
    mkdirSync(paths.defaultBinDir, { recursive: true })
    symlinkSync(real, wrapper())
    expect(() => installDefaultShim(paths, 'glm', [fake])).toThrow(ProfileError)
    expect(lstatSync(wrapper()).isSymbolicLink()).toBe(true)
    expect(readFileSync(real, 'utf8')).toContain('echo real')
  })

  test('a profile launcher is not mistaken for it, nor it for a launcher', () => {
    mkdirSync(paths.defaultBinDir, { recursive: true })
    writeFileSync(wrapper(), renderShim([fake], 'glm'), { mode: 0o755 }) // marker of a launcher
    expect(inspectDefaultShim(paths, {}).state).toBe('foreign')
    expect(() => installDefaultShim(paths, 'glm', [fake])).toThrow(ProfileError)

    installShim(paths, 'glm', [fake])
    installDefaultShim({ ...paths, defaultBinDir: join(home, 'elsewhere') }, 'glm', [fake])
    expect(listShims(paths).map((s) => s.command)).toEqual(['glm'])
  })

  test('refuses an unknown shape of profile name', () => {
    expect(() => installDefaultShim(paths, '../glm', [fake])).toThrow(ProfileError)
    expect(existsSync(paths.defaultBinDir)).toBe(false)
  })

  // The launcher directory must keep refusing `claude`: a launcher named claude would be
  // found first by `ccprovider use`, which looks claude up again.
  // ccprovider runs these itself (the token footer's installer), so a launcher by their name
  // would be started with `-c ...` and run as Claude Code with the continue flag.
  test.each(['python3', 'python'])('a profile cannot be installed as `%s` either', (name) => {
    expect(() => commandName(name)).toThrow(/cannot be installed as a command/)
  })

  test('a profile still cannot be installed as a `claude` command, and is pointed here instead', () => {
    expect(() => commandName('claude')).toThrow(/ccprovider default/)
  })
})

describe('inspecting the default wrapper', () => {
  test('absent, then ours with its profile and a working target', () => {
    expect(inspectDefaultShim(paths, {}).state).toBe('absent')
    installDefaultShim(paths, 'glm', [fake])
    const s = inspectDefaultShim(paths, {})
    expect(s.state).toBe('ours')
    expect(s.profile).toBe('glm')
    expect(s.launcher).toEqual([fake])
    expect(s.targetOk).toBe(true)
  })

  test('notices that the program it execs is gone', () => {
    installDefaultShim(paths, 'glm', [join(home, 'gone')])
    expect(inspectDefaultShim(paths, {}).targetOk).toBe(false)
  })

  test('says whether its directory is on PATH, and what answers to `claude` before it', () => {
    installDefaultShim(paths, 'glm', [fake])
    const real = claudeIn(join(home, 'real'), 'real')

    const off = inspectDefaultShim(paths, { PATH: join(home, 'real') })
    expect(off.dirOnPath).toBe(false)
    expect(off.shadowedBy).toBe(real) // not on PATH: the real one is what runs

    const behind = inspectDefaultShim(paths, { PATH: `${join(home, 'real')}:${paths.defaultBinDir}` })
    expect(behind.dirOnPath).toBe(true)
    expect(behind.shadowedBy).toBe(real)

    const first = inspectDefaultShim(paths, { PATH: `${paths.defaultBinDir}:${join(home, 'real')}` })
    expect(first.dirOnPath).toBe(true)
    expect(first.shadowedBy).toBeUndefined()
  })
})

describe('telling whether a file is the default wrapper', () => {
  test('is true for the wrapper, false for a launcher, a foreign script and a missing file', () => {
    installDefaultShim(paths, 'glm', [fake])
    installShim(paths, 'glm', [fake])
    expect(isDefaultWrapper(wrapper())).toBe(true)
    expect(isDefaultWrapper(join(paths.binDir, 'glm'))).toBe(false)
    writeFileSync(join(home, 'other'), '#!/bin/sh\n', { mode: 0o755 })
    expect(isDefaultWrapper(join(home, 'other'))).toBe(false)
    expect(isDefaultWrapper(join(home, 'nothing'))).toBe(false)
  })
})

describe('removing the default wrapper', () => {
  test('removes ours, and says so when there is none', () => {
    installDefaultShim(paths, 'glm', [fake])
    expect(removeDefaultShim(paths)).toBe('removed')
    expect(existsSync(wrapper())).toBe(false)
    expect(removeDefaultShim(paths)).toBe('absent')
  })

  test('leaves a claude it did not write', () => {
    mkdirSync(paths.defaultBinDir, { recursive: true })
    writeFileSync(wrapper(), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    expect(removeDefaultShim(paths)).toBe('foreign')
    expect(existsSync(wrapper())).toBe(true)
  })

  test('given a profile, removes it only when it is the one the wrapper runs', () => {
    installDefaultShim(paths, 'glm', [fake])
    expect(removeDefaultShim(paths, 'kimi')).toBe('elsewhere')
    expect(existsSync(wrapper())).toBe(true)
    expect(removeDefaultShim(paths, 'glm')).toBe('removed')
  })
})

describe('findOnPath', () => {
  test('is the first executable of that name on PATH', () => {
    const a = claudeIn(join(home, 'a'), 'a')
    claudeIn(join(home, 'b'), 'b')
    expect(findOnPath('claude', `${join(home, 'a')}:${join(home, 'b')}`)).toBe(a)
  })

  test('steps over the directories it is told to skip', () => {
    claudeIn(join(home, 'a'), 'a')
    const b = claudeIn(join(home, 'b'), 'b')
    expect(findOnPath('claude', `${join(home, 'a')}:${join(home, 'b')}`, [join(home, 'a')])).toBe(b)
  })

  test('skips a directory however it is spelled on PATH', () => {
    claudeIn(join(home, 'a'), 'a')
    const b = claudeIn(join(home, 'b'), 'b')
    expect(findOnPath('claude', `${join(home, 'a')}/../a:${join(home, 'b')}`, [join(home, 'a')])).toBe(b)
  })

  test('ignores a file that is not executable, and finds nothing on an empty PATH', () => {
    mkdirSync(join(home, 'a'))
    writeFileSync(join(home, 'a', 'claude'), 'x', { mode: 0o644 })
    expect(findOnPath('claude', join(home, 'a'))).toBeUndefined()
    expect(findOnPath('claude', undefined)).toBeUndefined()
  })
})

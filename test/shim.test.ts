import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  binDirOnPath,
  commandName,
  findOtherProgram,
  findShadow,
  inspectShim,
  installCommandFor,
  installShim,
  listShims,
  removeShim,
  renderShim,
  selfLauncher,
} from '../src/shim.js'
import { ProfileError } from '../src/profile.js'
import type { Paths } from '../src/paths.js'

let home: string
let paths: Paths
let fake: string // a stand-in for the ccprovider binary that records how it was called
let argsOut: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-shim-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, '.config/ccprovider/providers.json'),
    dirsRoot: join(home, '.local/share/ccprovider/dirs'),
    cacheDir: join(home, '.cache/ccprovider'),
    binDir: join(home, 'bin'),
  }
  argsOut = join(home, 'args.out')
  fake = join(home, 'fake-ccprovider')
  // NUL-separated so an argument containing a newline or a space stays one argument.
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argsOut}'\nexit 7\n`, { mode: 0o755 })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const recorded = () => readFileSync(argsOut, 'utf8').split('\0').slice(0, -1)

describe('the generated launcher', () => {
  test('hands every argument to `use <name> --` untouched, and returns the exit code', () => {
    installShim(paths, 'glm', [fake])
    // Regression guard for the quoting: none of these may be split, expanded or executed.
    const hostile = ['a b', "it's", '$(touch PWNED)', '`touch PWNED`', '*', '', '--help', '-m', 'opus', '-y']
    const r = spawnSync(join(paths.binDir, 'glm'), hostile, { cwd: home })

    expect(r.status).toBe(7) // the launcher's exit status is the program's, not its own
    expect(recorded()).toEqual(['use', 'glm', '--', ...hostile])
    expect(existsSync(join(home, 'PWNED'))).toBe(false)
  })

  test('is a plain POSIX sh script, so it works from bash, zsh and fish alike', () => {
    const text = renderShim([fake], 'glm')
    expect(text.startsWith('#!/bin/sh\n')).toBe(true)
    for (const shell of ['bash', 'zsh', 'sh']) {
      const which = spawnSync('sh', ['-c', `command -v ${shell}`])
      if (which.status !== 0) continue
      installShim(paths, 'glm', [fake])
      const r = spawnSync(shell, ['-c', `${join(paths.binDir, 'glm')} one two`])
      expect(r.status).toBe(7)
      expect(recorded()).toEqual(['use', 'glm', '--', 'one', 'two'])
    }
  })

  test('a path containing a quote survives the round trip', () => {
    const odd = join(home, "it's here")
    mkdirSync(odd)
    const bin = join(odd, 'ccprovider')
    writeFileSync(bin, readFileSync(fake), { mode: 0o755 })
    installShim(paths, 'glm', [bin])

    expect(listShims(paths)[0]!.launcher).toEqual([bin])
    expect(spawnSync(join(paths.binDir, 'glm'), ['x']).status).toBe(7)
  })

  test('contains the profile name and launcher, and nothing else that varies', () => {
    expect(renderShim(['/opt/cc/ccprovider'], 'glm')).toBe(
      [
        '#!/bin/sh',
        '# ccprovider-shim profile=glm - managed by ccprovider, do not edit',
        `exec '/opt/cc/ccprovider' use 'glm' -- "$@"`,
        '',
      ].join('\n'),
    )
  })

  test('refuses a launcher path containing a line break, which it could not read back', () => {
    expect(() => renderShim(['/opt/odd\nname/ccprovider'], 'glm')).toThrow(/line break/)
    expect(() => installShim(paths, 'glm', ['/opt/odd\rname/ccprovider'])).toThrow(ProfileError)
    expect(existsSync(join(paths.binDir, 'glm'))).toBe(false)
  })

  test('supports a runtime plus script launcher (running from source)', () => {
    const text = renderShim(['/usr/local/bin/bun', '/src/cli.ts'], 'glm')
    expect(text).toContain(`exec '/usr/local/bin/bun' '/src/cli.ts' use 'glm' -- "$@"`)
  })
})

describe('installShim', () => {
  test('creates an executable file, then reports unchanged, then updated', () => {
    expect(installShim(paths, 'glm', [fake]).action).toBe('created')
    expect(statSync(join(paths.binDir, 'glm')).mode & 0o777).toBe(0o755)
    expect(installShim(paths, 'glm', [fake]).action).toBe('unchanged')
    expect(installShim(paths, 'glm', [fake, 'extra']).action).toBe('updated')
    expect(listShims(paths)[0]!.launcher).toEqual([fake, 'extra'])
  })

  test('leaves no temporary file behind', () => {
    installShim(paths, 'glm', [fake])
    installShim(paths, 'glm', [fake, 'x'])
    expect(readdirSync(paths.binDir)).toEqual(['glm'])
  })

  test('refuses to overwrite a file it did not create', () => {
    mkdirSync(paths.binDir, { recursive: true })
    const mine = join(paths.binDir, 'kimi')
    writeFileSync(mine, '#!/bin/sh\necho the real kimi\n', { mode: 0o755 })

    expect(() => installShim(paths, 'kimi', [fake])).toThrow(ProfileError)
    expect(readFileSync(mine, 'utf8')).toBe('#!/bin/sh\necho the real kimi\n')
  })

  test('refuses to replace a symlink, and never writes through it', () => {
    // Regression: ~/.local/bin/claude and ~/.local/bin/kimi are symlinks to real programs.
    mkdirSync(paths.binDir, { recursive: true })
    const target = join(home, 'real-program')
    writeFileSync(target, 'REAL', { mode: 0o755 })
    symlinkSync(target, join(paths.binDir, 'kimi'))

    expect(() => installShim(paths, 'kimi', [fake])).toThrow(/not created by ccprovider/)
    expect(lstatSync(join(paths.binDir, 'kimi')).isSymbolicLink()).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('REAL')
  })

  test('a hand-edited marker naming another profile is not trusted', () => {
    mkdirSync(paths.binDir, { recursive: true })
    writeFileSync(join(paths.binDir, 'glm'), renderShim([fake], 'someone-else'), { mode: 0o755 })
    expect(() => installShim(paths, 'glm', [fake])).toThrow(ProfileError)
  })

  test.each(['claude', 'ccprovider', 'CLAUDE', 'which', 'security', 'secret-tool', 'node', 'npx'])(
    '%s is never installed as a command',
    (name) => {
      // Regression: these are the programs ccprovider itself looks up on PATH, so a launcher
      // by that name would be found first and call itself forever.
      expect(() => installShim(paths, name, [fake])).toThrow(/cannot be installed as a command/)
      expect(existsSync(join(paths.binDir, name.toLowerCase()))).toBe(false)
    },
  )

  test('commandName keeps the profile-name rules', () => {
    expect(() => commandName('../evil')).toThrow(ProfileError)
    expect(commandName('GLM')).toBe('glm')
  })
})

describe('removeShim', () => {
  test('removes a launcher it wrote', () => {
    installShim(paths, 'glm', [fake])
    expect(removeShim(paths, 'glm')).toBe('removed')
    expect(existsSync(join(paths.binDir, 'glm'))).toBe(false)
  })

  test('never deletes a file or symlink it did not write', () => {
    mkdirSync(paths.binDir, { recursive: true })
    const target = join(home, 'real')
    writeFileSync(target, 'REAL', { mode: 0o755 })
    symlinkSync(target, join(paths.binDir, 'claude'))
    writeFileSync(join(paths.binDir, 'tool'), '#!/bin/sh\n', { mode: 0o755 })

    // A profile called "claude" is legal even though it cannot become a command; rm must
    // still be safe for it.
    expect(removeShim(paths, 'claude')).toBe('foreign')
    expect(removeShim(paths, 'tool')).toBe('foreign')
    expect(existsSync(target)).toBe(true)
    expect(existsSync(join(paths.binDir, 'tool'))).toBe(true)
  })

  test('is quiet when there is nothing to remove', () => {
    expect(removeShim(paths, 'glm')).toBe('absent')
  })
})

describe('listShims', () => {
  test('returns only launchers ccprovider wrote', () => {
    installShim(paths, 'glm', [fake])
    installShim(paths, 'deepseek', [fake])
    writeFileSync(join(paths.binDir, 'plain'), '#!/bin/sh\necho hi\n', { mode: 0o755 })
    writeFileSync(join(paths.binDir, 'big'), 'x'.repeat(10_000), { mode: 0o755 })
    symlinkSync(fake, join(paths.binDir, 'linked'))

    expect(listShims(paths).map((s) => s.command).sort()).toEqual(['deepseek', 'glm'])
  })

  test('a missing bin directory is simply empty', () => {
    expect(listShims(paths)).toEqual([])
  })

  test('copies and renamed files carrying a marker are not listed — removeShim would refuse them', () => {
    // Regression: `cp glm glm.bak` left a file that bulk uninstall listed, then "removed"
    // according to its summary while removeShim refused it (or threw on the odd name).
    installShim(paths, 'glm', [fake])
    const body = readFileSync(join(paths.binDir, 'glm'), 'utf8')
    writeFileSync(join(paths.binDir, 'glm.bak'), body, { mode: 0o755 })
    writeFileSync(join(paths.binDir, 'work'), body, { mode: 0o755 })
    writeFileSync(join(paths.binDir, 'glm~'), body, { mode: 0o755 })

    expect(listShims(paths).map((x) => x.command)).toEqual(['glm'])
  })
})

describe('inspectShim', () => {
  test('reports absent, foreign and ours', () => {
    expect(inspectShim(paths, 'glm', { PATH: '' }).state).toBe('absent')

    mkdirSync(paths.binDir, { recursive: true })
    writeFileSync(join(paths.binDir, 'glm'), '#!/bin/sh\n', { mode: 0o755 })
    expect(inspectShim(paths, 'glm', { PATH: '' }).state).toBe('foreign')

    rmSync(join(paths.binDir, 'glm'))
    installShim(paths, 'glm', [fake])
    const s = inspectShim(paths, 'glm', { PATH: '' })
    expect(s.state).toBe('ours')
    expect(s.targetOk).toBe(true)
  })

  test('notices when the program a launcher points at has gone', () => {
    installShim(paths, 'glm', [fake])
    rmSync(fake)
    expect(inspectShim(paths, 'glm', { PATH: '' }).targetOk).toBe(false)
  })

  test('notices a launcher whose program lost its executable bit', () => {
    installShim(paths, 'glm', [fake])
    chmodSync(fake, 0o644)
    expect(inspectShim(paths, 'glm', { PATH: '' }).targetOk).toBe(false)
  })
})

describe('PATH', () => {
  test('binDirOnPath, including through a symlinked entry', () => {
    mkdirSync(paths.binDir)
    const link = join(home, 'link-to-bin')
    symlinkSync(paths.binDir, link)
    expect(binDirOnPath(paths.binDir, `/usr/bin:${paths.binDir}`)).toBe(true)
    expect(binDirOnPath(paths.binDir, `/usr/bin:${link}`)).toBe(true)
    expect(binDirOnPath(paths.binDir, '/usr/bin:/bin')).toBe(false)
    expect(binDirOnPath(paths.binDir, undefined)).toBe(false)
  })

  test('a same-named program earlier on PATH is reported as shadowing', () => {
    const earlier = join(home, 'earlier')
    mkdirSync(earlier)
    mkdirSync(paths.binDir)
    writeFileSync(join(earlier, 'glm'), '#!/bin/sh\n', { mode: 0o755 })

    expect(findShadow('glm', paths.binDir, `${earlier}:${paths.binDir}`)).toBe(join(earlier, 'glm'))
    // Ours comes first, so we are the one doing the shadowing — not a problem to report.
    expect(findShadow('glm', paths.binDir, `${paths.binDir}:${earlier}`)).toBeUndefined()
  })

  test('with binDir off PATH, whatever answers to the name today is reported', () => {
    const other = join(home, 'other')
    mkdirSync(other)
    writeFileSync(join(other, 'glm'), '#!/bin/sh\n', { mode: 0o755 })
    expect(findShadow('glm', paths.binDir, other)).toBe(join(other, 'glm'))
  })

  test('findOtherProgram finds a real program elsewhere on PATH, and ignores binDir itself', () => {
    const elsewhere = join(home, 'homebrew')
    mkdirSync(elsewhere)
    mkdirSync(paths.binDir)
    writeFileSync(join(elsewhere, 'gemini'), '#!/bin/sh\n', { mode: 0o755 })
    writeFileSync(join(paths.binDir, 'gemini'), '#!/bin/sh\n', { mode: 0o755 })

    expect(findOtherProgram('gemini', paths.binDir, `${paths.binDir}:${elsewhere}`)).toBe(join(elsewhere, 'gemini'))
    expect(findOtherProgram('gemini', paths.binDir, paths.binDir)).toBeUndefined()
    expect(findOtherProgram('nothing', paths.binDir, `${paths.binDir}:${elsewhere}`)).toBeUndefined()
  })

  test('a non-executable file of the same name is not a shadow', () => {
    const earlier = join(home, 'earlier')
    mkdirSync(earlier)
    writeFileSync(join(earlier, 'glm'), 'data', { mode: 0o644 })
    expect(findShadow('glm', paths.binDir, `${earlier}:${paths.binDir}`)).toBeUndefined()
  })
})

describe('selfLauncher', () => {
  test('a JavaScript entry is its own launcher — its shebang finds node, so no interpreter path is baked in', () => {
    // Regression guard: under nvm/fnm process.execPath is a versioned path that disappears
    // when the user changes Node version, taking every launcher with it.
    const script = join(home, 'cli.js')
    writeFileSync(script, '#!/usr/bin/env node\n')
    expect(selfLauncher('/home/u/.nvm/versions/node/v22.1.0/bin/node', script)).toEqual([realpathSync(script)])
  })

  test('.mjs and .cjs entries too', () => {
    for (const ext of ['mjs', 'cjs']) {
      const script = join(home, `cli.${ext}`)
      writeFileSync(script, '')
      expect(selfLauncher('/usr/bin/node', script)).toEqual([realpathSync(script)])
    }
  })

  test('from TypeScript source it is the runtime plus the real path of the script', () => {
    const script = join(home, 'cli.ts')
    writeFileSync(script, '')
    const link = join(home, 'link.ts')
    symlinkSync(script, link)
    expect(selfLauncher('/usr/bin/bun', link)).toEqual(['/usr/bin/bun', realpathSync(script)])
  })

  test('an npm-style bin symlink resolves to the real file inside the package', () => {
    const pkg = join(home, 'lib/node_modules/ccprovider/dist')
    mkdirSync(pkg, { recursive: true })
    const real = join(pkg, 'cli.js')
    writeFileSync(real, '')
    mkdirSync(join(home, 'bin-dir'))
    const bin = join(home, 'bin-dir', 'ccprovider')
    symlinkSync(real, bin)
    expect(selfLauncher('/usr/bin/node', bin)).toEqual([realpathSync(real)])
  })

  test('refuses when it cannot tell how it was started', () => {
    expect(() => selfLauncher('/usr/bin/node', '')).toThrow(ProfileError)
  })
})

describe('installCommandFor (what `add` does on the user\'s behalf)', () => {
  const launcher = () => [fake]
  const run = (name: string, automatic: boolean, PATH: string) => installCommandFor(paths, name, launcher, { automatic, env: { PATH } })

  test('installs, and is usable when binDir is on PATH and nothing shadows it', () => {
    const r = run('glm', true, paths.binDir)
    expect(r).toMatchObject({ ok: true, usable: true, action: 'created', path: join(paths.binDir, 'glm') })
    expect(r.shadows).toBeUndefined()
  })

  test('is installed but not usable when binDir is off PATH — callers must not promise the short form', () => {
    const r = run('glm', true, '/usr/bin')
    expect(r.ok).toBe(true)
    expect(r.usable).toBe(false)
  })

  test('asked for by name, it installs even when another program earlier on PATH wins — but is not usable', () => {
    const earlier = join(home, 'earlier')
    mkdirSync(earlier)
    writeFileSync(join(earlier, 'glm'), '#!/bin/sh\n', { mode: 0o755 })
    const r = run('glm', false, `${earlier}:${paths.binDir}`)
    expect(r.ok).toBe(true)
    expect(r.usable).toBe(false) // the earlier program is what typing `glm` runs
    expect(r.shadowedBy).toBe(join(earlier, 'glm'))
  })

  test('an automatic install steps aside for a real program elsewhere on PATH', () => {
    // Regression: `add` for a profile named `gemini` used to replace the real gemini CLI
    // (binDir is normally first on PATH) and print "✓ command created".
    const brew = join(home, 'homebrew')
    mkdirSync(brew)
    writeFileSync(join(brew, 'gemini'), '#!/bin/sh\n', { mode: 0o755 })

    const r = run('gemini', true, `${paths.binDir}:${brew}`)

    expect(r.ok).toBe(false)
    expect(r.error).toContain(join(brew, 'gemini'))
    expect(r.error).toContain('ccprovider install gemini')
    expect(existsSync(join(paths.binDir, 'gemini'))).toBe(false)
  })

  test('asking for it by name installs, and says what it now stands in front of', () => {
    const brew = join(home, 'homebrew')
    mkdirSync(brew)
    writeFileSync(join(brew, 'gemini'), '#!/bin/sh\n', { mode: 0o755 })

    const r = run('gemini', false, `${paths.binDir}:${brew}`)

    expect(r).toMatchObject({ ok: true, usable: true, shadows: join(brew, 'gemini') })
    expect(existsSync(join(paths.binDir, 'gemini'))).toBe(true)
  })

  test('a filesystem error is a report, never a crash', () => {
    // Regression: only ProfileError was caught, so EACCES on a root-owned ~/.local/bin gave
    // a stack trace *after* the profile and key were already saved.
    writeFileSync(paths.binDir, 'not a directory') // mkdir on this fails with EEXIST/ENOTDIR
    const r = run('glm', true, paths.binDir)
    expect(r.ok).toBe(false)
    expect(r.error).toBeTruthy()
  })

  test('a file that is not ours is reported with the reason', () => {
    mkdirSync(paths.binDir, { recursive: true })
    writeFileSync(join(paths.binDir, 'kimi'), '#!/bin/sh\necho real\n', { mode: 0o755 })
    const r = run('kimi', true, paths.binDir)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('not created by ccprovider')
  })

  test('a reserved name is reported, not thrown', () => {
    const r = run('claude', false, paths.binDir)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('cannot be installed as a command')
  })
})

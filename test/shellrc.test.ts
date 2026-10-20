import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BLOCK_BEGIN, BLOCK_END, detectRcFile, pathBlockLines, readManagedBlock, upsertManagedBlock } from '../src/shellrc.js'

let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-rc-'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('detectRcFile', () => {
  test('zsh and bash map to their interactive rc files', () => {
    expect(detectRcFile({ SHELL: '/bin/zsh' }, home, 'linux')).toEqual({ shell: 'zsh', file: join(home, '.zshrc') })
    expect(detectRcFile({ SHELL: '/usr/local/bin/bash' }, home, 'linux')).toEqual({ shell: 'bash', file: join(home, '.bashrc') })
  })

  // Terminal and iTerm open *login* shells, and a login bash reads the first of
  // ~/.bash_profile, ~/.bash_login and ~/.profile — never ~/.bashrc on its own.
  test('bash on macOS gets the file a login shell reads', () => {
    const bash = { SHELL: '/bin/bash' }
    expect(detectRcFile(bash, home, 'darwin')!.file).toBe(join(home, '.bash_profile'))
    writeFileSync(join(home, '.profile'), '')
    expect(detectRcFile(bash, home, 'darwin')!.file).toBe(join(home, '.profile'))
    writeFileSync(join(home, '.bash_login'), '')
    expect(detectRcFile(bash, home, 'darwin')!.file).toBe(join(home, '.bash_login'))
    writeFileSync(join(home, '.bash_profile'), '')
    expect(detectRcFile(bash, home, 'darwin')!.file).toBe(join(home, '.bash_profile'))
  })

  test('zsh is the same on every platform', () => {
    expect(detectRcFile({ SHELL: '/bin/zsh' }, home, 'darwin')!.file).toBe(join(home, '.zshrc'))
  })

  test('anything else, or nothing, is a manual job', () => {
    expect(detectRcFile({ SHELL: '/usr/bin/fish' }, home)).toBeNull()
    expect(detectRcFile({}, home)).toBeNull()
  })
})

describe('pathBlockLines', () => {
  test('the default dir always, the launchers dir when asked for', () => {
    expect(pathBlockLines('/a/bin', null)).toEqual(['export PATH="/a/bin:$PATH"'])
    expect(pathBlockLines('/a/bin', '/b/bin')).toContain('export PATH="/b/bin:$PATH"')
  })

  // Each line puts its directory in front, so the last line wins the front. The launchers
  // dir holds Claude Code's own `claude`; the default wrapper has to come before it.
  test('the default dir ends up first on PATH, ahead of the launchers dir', () => {
    const sh = spawnSync('sh', ['-c', `PATH=/previous\n${pathBlockLines('/a/bin', '/b/bin').join('\n')}\nprintf '%s' "$PATH"`], { encoding: 'utf8' })
    expect(sh.stdout).toBe('/a/bin:/b/bin:/previous')
  })
})

describe('upsertManagedBlock', () => {
  const rc = () => join(home, '.zshrc')
  const lines = () => pathBlockLines(join(home, 'default-bin'), null)

  test('creates a missing file, fenced by markers', () => {
    expect(upsertManagedBlock(rc(), lines())).toBe('created')
    const text = readFileSync(rc(), 'utf8')
    expect(text).toBe(`${BLOCK_BEGIN}\nexport PATH="${join(home, 'default-bin')}:$PATH"\n${BLOCK_END}\n`)
    expect(readManagedBlock(text)).toEqual(lines())
  })

  test('keeps everything around it, including a missing trailing newline', () => {
    writeFileSync(rc(), 'export EDITOR=helix')
    upsertManagedBlock(rc(), lines())
    const text = readFileSync(rc(), 'utf8')
    expect(text.startsWith('export EDITOR=helix\n')).toBe(true)
    expect(text.endsWith(`\n${BLOCK_END}\n`)).toBe(true)
  })

  test('is idempotent — the same lines again leave the bytes alone', () => {
    upsertManagedBlock(rc(), lines())
    const before = readFileSync(rc(), 'utf8')
    expect(upsertManagedBlock(rc(), lines())).toBe('unchanged')
    expect(readFileSync(rc(), 'utf8')).toBe(before)
  })

  test('replaces its own block instead of appending a second one', () => {
    upsertManagedBlock(rc(), lines())
    const moved = pathBlockLines('/new/place', null)
    expect(upsertManagedBlock(rc(), moved)).toBe('updated')
    const text = readFileSync(rc(), 'utf8')
    expect(text.split(BLOCK_BEGIN)).toHaveLength(2)
    expect(readManagedBlock(text)).toEqual(moved)
  })

  // The export line is double-quoted so `$PATH` expands — which means a directory holding
  // a `$` (or a space, a quote, a backslash) must be escaped, or sh would mangle it.
  test('a directory with a space and a dollar survives, as sh would read it', () => {
    const dir = `${join(home, 'weird dir')}$X`
    upsertManagedBlock(rc(), pathBlockLines(dir, null))
    const text = readFileSync(rc(), 'utf8')
    const sh = spawnSync('sh', ['-c', `PATH=/previous\n${text}\nprintf '%s' "$PATH"`], { encoding: 'utf8' })
    expect(sh.stdout).toBe(`${dir}:/previous`)
  })

  // Regression: a BEGIN with no END was left as found and a full block appended after it. The
  // next run took the first BEGIN to the new END and deleted whatever the user wrote between.
  test('a truncated block is never allowed to swallow the lines after it', () => {
    writeFileSync(rc(), `${BLOCK_BEGIN}\nexport MINE_ONE=1\nexport MINE_TWO=2\n`)
    upsertManagedBlock(rc(), lines())
    upsertManagedBlock(rc(), pathBlockLines('/moved', null))
    const text = readFileSync(rc(), 'utf8')
    expect(text).toContain('export MINE_ONE=1')
    expect(text).toContain('export MINE_TWO=2')
    expect(readManagedBlock(text)).toEqual(pathBlockLines('/moved', null))
  })

  test('the block read is the one that closes, not an earlier stray marker', () => {
    const text = `${BLOCK_BEGIN}\nstray\n${BLOCK_BEGIN}\nreal\n${BLOCK_END}\n`
    expect(readManagedBlock(text)).toEqual(['real'])
  })

  // Regression: every read error was taken for an empty file, so a transient failure on a
  // dotfile that exists wrote a file holding only the block.
  test('a file that cannot be read is an error, not an empty file', () => {
    // Write-only: reading fails with EACCES while a write would still go through.
    writeFileSync(rc(), 'export KEEP=1\n', { mode: 0o200 })
    try {
      expect(() => upsertManagedBlock(rc(), lines())).toThrow()
    } finally {
      chmodSync(rc(), 0o600)
    }
    expect(readFileSync(rc(), 'utf8')).toBe('export KEEP=1\n')
  })

  test('a file with Windows line endings is recognised, not appended to again', () => {
    const crlf = `export A=1\r\n${BLOCK_BEGIN}\r\n${lines().join('\r\n')}\r\n${BLOCK_END}\r\n`
    writeFileSync(rc(), crlf)
    expect(upsertManagedBlock(rc(), lines())).toBe('unchanged')
    expect(readFileSync(rc(), 'utf8')).toBe(crlf)
    upsertManagedBlock(rc(), pathBlockLines('/moved', null))
    const text = readFileSync(rc(), 'utf8')
    expect(text.split(BLOCK_BEGIN)).toHaveLength(2)
    expect(text).not.toMatch(/[^\r]\n/)
  })

  test('content without markers reads as none', () => {
    expect(readManagedBlock('export PATH=/x:$PATH\n')).toBeNull()
    expect(readManagedBlock('')).toBeNull()
    expect(existsSync(rc())).toBe(false)
  })
})

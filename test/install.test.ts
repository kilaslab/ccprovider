import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// install.sh is what most users will run first, and it downloads and executes a binary,
// so its verification path is tested against a local "release" served over file://.

const script = join(import.meta.dir, '..', 'install.sh')
const asset = `ccprovider-${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const BINARY = '#!/bin/sh\necho 9.9.9\n'

let root: string
let dest: string

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** Lay out a release the way GitHub serves one: <base>/latest/download and <base>/download/<tag>. */
function publish(opts: { binary?: string; sums?: string; tag?: string } = {}) {
  const dir = opts.tag ? join(root, 'rel/download', opts.tag) : join(root, 'rel/latest/download')
  mkdirSync(dir, { recursive: true })
  const binary = opts.binary ?? BINARY
  writeFileSync(join(dir, asset), binary)
  writeFileSync(join(dir, 'SHA256SUMS'), opts.sums ?? `${sha(BINARY)}  ${asset}\n${sha('other')}  ccprovider-other-arch\n`)
}

function install(args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync('sh', [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH!, HOME: root, CCPROVIDER_RELEASE_BASE: `file://${join(root, 'rel')}`, CCPROVIDER_INSTALL_DIR: dest, ...env },
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccprov-install-'))
  dest = join(root, 'dest')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('install.sh', () => {
  test('installs the latest release, executable, and reports its version', () => {
    publish()
    const r = install()

    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Installed ccprovider 9.9.9')
    expect(statSync(join(dest, 'ccprovider')).mode & 0o777).toBe(0o755)
    expect(readFileSync(join(dest, 'ccprovider'), 'utf8')).toBe(BINARY)
  })

  test('leaves nothing but the binary behind', () => {
    publish()
    install()
    expect(readdirSync(dest)).toEqual(['ccprovider'])
  })

  test('installs a pinned version from its own release', () => {
    publish({ tag: 'v9.9.9' })
    expect(install(['v9.9.9']).status).toBe(0)
    expect(existsSync(join(dest, 'ccprovider'))).toBe(true)
  })

  test('replaces an existing install', () => {
    publish()
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'ccprovider'), 'OLD')
    expect(install().status).toBe(0)
    expect(readFileSync(join(dest, 'ccprovider'), 'utf8')).toBe(BINARY)
  })

  test('a checksum mismatch installs nothing and leaves the existing install alone', () => {
    // Regression guard: the download is executed, so a corrupted or swapped binary must
    // be refused, and refusing must not cost the user the working copy they had.
    publish({ binary: '#!/bin/sh\necho tampered\n' })
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'ccprovider'), 'OLD')

    const r = install()

    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('checksum mismatch')
    expect(readFileSync(join(dest, 'ccprovider'), 'utf8')).toBe('OLD')
    expect(readdirSync(dest)).toEqual(['ccprovider']) // no temp directory either
  })

  test('a verified binary that cannot run here is refused, and the working install is kept', () => {
    // Regression: the version was read *after* the move, so a binary with the right checksum
    // but the wrong libc replaced a good install and the script still reported success.
    const broken = '#!/bin/sh\nexit 1\n'
    publish({ binary: broken, sums: `${sha(broken)}  ${asset}\n` })
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, 'ccprovider'), 'OLD')

    const r = install()

    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('does not run on this machine')
    expect(r.stdout).not.toContain('Installed')
    expect(readFileSync(join(dest, 'ccprovider'), 'utf8')).toBe('OLD')
    expect(readdirSync(dest)).toEqual(['ccprovider'])
  })

  test('a release with no checksum for this platform is refused', () => {
    publish({ sums: `${sha('x')}  ccprovider-some-other-platform\n` })
    const r = install()
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain(`no entry for ${asset}`)
    expect(existsSync(join(dest, 'ccprovider'))).toBe(false)
  })

  test('an empty checksum file is refused rather than skipped', () => {
    publish({ sums: '' })
    expect(install().status).not.toBe(0)
    expect(existsSync(join(dest, 'ccprovider'))).toBe(false)
  })

  test('a missing release says so', () => {
    const r = install(['v0.0.0'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('could not download')
  })

  test('warns when the install directory is not on PATH, and only then', () => {
    publish()
    expect(install().stdout).toContain('not on your PATH')
    expect(install([], { PATH: `${dest}:${process.env.PATH}` }).stdout).not.toContain('not on your PATH')
  })

  test('the script itself is executable POSIX sh', () => {
    expect(readFileSync(script, 'utf8').startsWith('#!/bin/sh\n')).toBe(true)
    expect(spawnSync('sh', ['-n', script]).status).toBe(0)
    chmodSync(script, 0o755)
  })
})

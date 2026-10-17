import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  addStatusline,
  compareVersions,
  declineStatusline,
  ensureSource,
  findLocalSource,
  inspectStatusline,
  removeStatusline,
  runOffer,
  statuslineDeclined,
  type SourceSpec,
} from '../src/statusline.js'
import { renderShim } from '../src/shim.js'
import type { Paths } from '../src/paths.js'

let home: string
let paths: Paths

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

/** A stand-in for the upstream repository: a tiny installer that does what the real one
 *  does to the two things that matter here, and records where it was told to work. */
const INSTALLER = `#!/usr/bin/env python3
import json, os, sys
cfg = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "ran.log"), "a").write(cfg + " " + " ".join(sys.argv[1:]) + "\\n")
path = os.path.join(cfg, "settings.json")
s = json.load(open(path)) if os.path.exists(path) else {}
if "--uninstall" in sys.argv:
    s.pop("statusLine", None)
    os.remove(os.path.join(cfg, "hooks", "tokens_statusline.py"))
else:
    os.makedirs(os.path.join(cfg, "hooks"), exist_ok=True)
    open(os.path.join(cfg, "hooks", "tokens_statusline.py"), "w").write("# badge\\n")
    json.dump({"version": "9.9.9"}, open(os.path.join(cfg, "hooks", "cc-token-statusline-installed.json"), "w"))
    s["statusLine"] = {"type": "command", "command": '"/usr/bin/python3" "' + os.path.join(cfg, "hooks", "tokens_statusline.py") + '"'}
json.dump(s, open(path, "w"))
print("installer ok")
`

const FILES: Record<string, string> = {
  'scripts/install.py': INSTALLER,
  'scripts/statusline_chain.py': '# chain\n',
  'scripts/tokens_statusline.py': '# badge source\n',
  '.claude-plugin/plugin.json': '{"version":"9.9.9"}\n',
}

const source: SourceSpec = {
  repo: 'example/badge',
  commit: 'c'.repeat(40),
  version: '9.9.9',
  files: Object.entries(FILES).map(([path, body]) => ({ path, sha256: sha(body) })),
}

const writeSource = (dir: string, files: Record<string, string> = FILES) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), body)
  }
  return dir
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-sl-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, '.config/ccprovider/providers.json'),
    dirsRoot: join(home, '.local/share/ccprovider/dirs'),
    cacheDir: join(home, '.cache/ccprovider'),
    binDir: join(home, 'bin'),
    defaultBinDir: join(home, 'default-bin'),
    usageDir: join(home, 'usage'),
  }
  mkdirSync(paths.claudeDir, { recursive: true })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const settings = (s: unknown) => writeFileSync(join(paths.claudeDir, 'settings.json'), JSON.stringify(s))
const readSettings = () => JSON.parse(readFileSync(join(paths.claudeDir, 'settings.json'), 'utf8'))
const hook = (name: string, body = 'x') => {
  mkdirSync(join(paths.claudeDir, 'hooks'), { recursive: true })
  writeFileSync(join(paths.claudeDir, 'hooks', name), body)
}

describe('inspectStatusline', () => {
  test('absent when there is no settings file, or no statusLine in it', () => {
    expect(inspectStatusline(paths.claudeDir)).toEqual({ state: 'absent' })
    settings({ model: 'sonnet' })
    expect(inspectStatusline(paths.claudeDir)).toEqual({ state: 'absent' })
  })

  test('ours when the command runs the badge, with its version and whether the script is there', () => {
    hook('tokens_statusline.py')
    hook('cc-token-statusline-installed.json', '{"version":"0.4.5"}')
    const script = join(paths.claudeDir, 'hooks', 'tokens_statusline.py')
    settings({ statusLine: { type: 'command', command: `"/bin/sh" "${script}"` } })
    expect(inspectStatusline(paths.claudeDir)).toEqual({ state: 'ours', command: `"/bin/sh" "${script}"`, chained: false, version: '0.4.5', working: true })
  })

  test('ours but not working when the script it names is gone, which hides the whole status bar', () => {
    const script = join(paths.claudeDir, 'hooks', 'tokens_statusline.py')
    settings({ statusLine: { type: 'command', command: `"/bin/sh" "${script}"` } })
    const s = inspectStatusline(paths.claudeDir)
    expect(s.state === 'ours' && s.working).toBe(false)
  })

  test('not working either when its interpreter is gone', () => {
    hook('tokens_statusline.py')
    const script = join(paths.claudeDir, 'hooks', 'tokens_statusline.py')
    settings({ statusLine: { type: 'command', command: `"${home}/no-python" "${script}"` } })
    const s = inspectStatusline(paths.claudeDir)
    expect(s.state === 'ours' && s.working).toBe(false)
  })

  test('ours and chained when the wrapper is what runs, since another status line comes first', () => {
    hook('statusline_chain.py')
    const script = join(paths.claudeDir, 'hooks', 'statusline_chain.py')
    settings({ statusLine: { type: 'command', command: `"/bin/sh" "${script}"` } })
    const s = inspectStatusline(paths.claudeDir)
    expect(s.state === 'ours' && s.chained).toBe(true)
  })

  // The installer writes absolute paths, but a hand-edited or generated command may not.
  test('expands ~ and $HOME the way the shell that runs the command will', () => {
    const hooks = join(home, '.claude', 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'tokens_statusline.py'), '#')
    for (const script of ['~/.claude/hooks/tokens_statusline.py', '$HOME/.claude/hooks/tokens_statusline.py', '${HOME}/.claude/hooks/tokens_statusline.py']) {
      settings({ statusLine: { type: 'command', command: `/bin/sh "${script}"` } })
      const s = inspectStatusline(paths.claudeDir, { HOME: home, PATH: '/bin' })
      expect(s.state === 'ours' && s.working).toBe(true)
    }
  })

  test('finds a bare interpreter name on the PATH it is given, not the process\'s', () => {
    hook('tokens_statusline.py')
    const script = join(paths.claudeDir, 'hooks', 'tokens_statusline.py')
    settings({ statusLine: { type: 'command', command: `sh "${script}"` } })
    expect(inspectStatusline(paths.claudeDir, { HOME: home, PATH: '/bin:/usr/bin' })).toMatchObject({ working: true })
    expect(inspectStatusline(paths.claudeDir, { HOME: home, PATH: join(home, 'nowhere') })).toMatchObject({ working: false })
  })

  // Older versions wired the script itself, with no interpreter in front of it.
  test('a command that is the script alone works when that file is executable', () => {
    hook('tokens-statusline.sh', '#!/bin/sh\n')
    const script = join(paths.claudeDir, 'hooks', 'tokens-statusline.sh')
    settings({ statusLine: { type: 'command', command: script } })
    expect(inspectStatusline(paths.claudeDir)).toMatchObject({ state: 'ours', working: false }) // not executable yet
    chmodSync(script, 0o755)
    expect(inspectStatusline(paths.claudeDir)).toMatchObject({ state: 'ours', working: true })
    settings({ statusLine: { type: 'command', command: `"${script}"` } })
    expect(inspectStatusline(paths.claudeDir)).toMatchObject({ state: 'ours', working: true })
  })

  test('finds the script in a wrapper command such as sh -c "python3 <script>"', () => {
    hook('tokens_statusline.py')
    const script = join(paths.claudeDir, 'hooks', 'tokens_statusline.py')
    settings({ statusLine: { type: 'command', command: `/bin/sh -c "/bin/sh ${script}"` } })
    expect(inspectStatusline(paths.claudeDir)).toMatchObject({ state: 'ours', working: true })
  })

  test('still reads a script path with a space in it as one word', () => {
    const spaced = join(home, 'Jane Doe', '.claude')
    mkdirSync(join(spaced, 'hooks'), { recursive: true })
    writeFileSync(join(spaced, 'hooks', 'tokens_statusline.py'), '#')
    writeFileSync(join(spaced, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `"/bin/sh" "${join(spaced, 'hooks', 'tokens_statusline.py')}"` } }))
    expect(inspectStatusline(spaced)).toMatchObject({ state: 'ours', working: true })
  })

  test('expands ${CLAUDE_CONFIG_DIR} and other variables, as the shell running the command will', () => {
    hook('tokens_statusline.py')
    settings({ statusLine: { type: 'command', command: '/bin/sh "${CLAUDE_CONFIG_DIR}/hooks/tokens_statusline.py"' } })
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin', CLAUDE_CONFIG_DIR: paths.claudeDir })).toMatchObject({ state: 'ours', working: true })
    settings({ statusLine: { type: 'command', command: `/bin/sh "$HOOKS/tokens_statusline.py"` } })
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin', HOOKS: join(paths.claudeDir, 'hooks') })).toMatchObject({ working: true })
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin' })).toMatchObject({ working: false })
  })

  // In a profile's session CLAUDE_CONFIG_DIR is the profile's directory, which has no hooks/.
  // Reporting the real directory's script as found would call a footer healthy that hides the
  // status bar in every profile.
  test('does not make up a value for CLAUDE_CONFIG_DIR, which a profile session sets to its own directory', () => {
    hook('tokens_statusline.py')
    settings({ statusLine: { type: 'command', command: '/bin/sh "${CLAUDE_CONFIG_DIR}/hooks/tokens_statusline.py"' } })
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin' })).toMatchObject({ state: 'ours', working: false })
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin', CLAUDE_CONFIG_DIR: join(home, 'a-profile') })).toMatchObject({ working: false })
  })

  // A script of the user's that calls the badge among other things: upstream leaves statusLine
  // alone, so ccprovider has to recognise it as the footer or it is offered again for ever.
  test('a status line script that runs the badge is the footer, reached through that script', () => {
    const combiner = join(home, 'combine.sh')
    writeFileSync(combiner, '#!/bin/sh\npython3 "$HOME/.claude/hooks/tokens_statusline.py"\necho other\n', { mode: 0o755 })
    settings({ statusLine: { type: 'command', command: combiner } })
    expect(inspectStatusline(paths.claudeDir)).toMatchObject({ state: 'ours', combined: true, working: true })
  })

  test('and one that does not is still somebody else\'s', () => {
    const other = join(home, 'other.sh')
    writeFileSync(other, '#!/bin/sh\necho just mine\n', { mode: 0o755 })
    settings({ statusLine: { type: 'command', command: other } })
    expect(inspectStatusline(paths.claudeDir)).toEqual({ state: 'foreign', command: other })
  })

  test('reads a single-quoted script path, and a ${VAR:-default} one', () => {
    hook('tokens_statusline.py')
    const script = join(paths.claudeDir, 'hooks', 'tokens_statusline.py')
    settings({ statusLine: { type: 'command', command: `/bin/sh '${script}'` } })
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin' })).toMatchObject({ state: 'ours', working: true })
    settings({ statusLine: { type: 'command', command: `/bin/sh "\${CLAUDE_CONFIG_DIR:-${paths.claudeDir}}/hooks/tokens_statusline.py"` } })
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin' })).toMatchObject({ working: true }) // unset: the default
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin', CLAUDE_CONFIG_DIR: '' })).toMatchObject({ working: true }) // empty: the default too
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin', CLAUDE_CONFIG_DIR: join(home, 'a-profile') })).toMatchObject({ working: false })
  })

  // The wrapper runs the badge; without the badge there is nothing for it to run.
  test('the chain wrapper is not working without the badge it appends', () => {
    hook('statusline_chain.py')
    const chain = join(paths.claudeDir, 'hooks', 'statusline_chain.py')
    settings({ statusLine: { type: 'command', command: `"/bin/sh" "${chain}"` } })
    expect(inspectStatusline(paths.claudeDir)).toMatchObject({ state: 'ours', chained: true, working: false })
    hook('tokens_statusline.py')
    expect(inspectStatusline(paths.claudeDir)).toMatchObject({ working: true })
  })

  // The names are matched as file names, not as pieces of text: `my_tokens_statusline.py` is
  // somebody else's script, and `rm` would otherwise run the uninstaller against it.
  test('a script that only has the badge\'s name inside its own name is somebody else\'s', () => {
    for (const command of ['/home/me/bin/my_tokens_statusline.py', `sh -c 'foo # not_statusline_chain.py'`, '/x/tokens_statusline.py.bak']) {
      settings({ statusLine: { type: 'command', command } })
      expect(inspectStatusline(paths.claudeDir)).toEqual({ state: 'foreign', command })
    }
  })

  // The plugin's own session nudge tells Claude to run its installer in the session's config
  // directory, which in a profile's session is the profile's. The shared settings.json then
  // names a script inside that profile, and removing the profile hides the status bar in all.
  test('a script inside a profile\'s directory is flagged, since removing that profile would break every profile\'s footer', () => {
    const profileHooks = join(paths.dirsRoot, 'pclaude', 'hooks')
    mkdirSync(profileHooks, { recursive: true })
    writeFileSync(join(profileHooks, 'tokens_statusline.py'), '#')
    settings({ statusLine: { type: 'command', command: `"/bin/sh" "${join(profileHooks, 'tokens_statusline.py')}"` } })
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin' }, paths.dirsRoot)).toMatchObject({ state: 'ours', working: true, misplaced: profileHooks })
    // Without being told where the profiles are, it cannot know.
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin' })).not.toHaveProperty('misplaced')
  })

  test('one in the real config directory is where it belongs', () => {
    hook('tokens_statusline.py')
    settings({ statusLine: { type: 'command', command: `"/bin/sh" "${join(paths.claudeDir, 'hooks', 'tokens_statusline.py')}"` } })
    expect(inspectStatusline(paths.claudeDir, { PATH: '/bin' }, paths.dirsRoot)).not.toHaveProperty('misplaced')
  })

  test('foreign when something else is the status line', () => {
    settings({ statusLine: { type: 'command', command: 'ccusage statusline' } })
    expect(inspectStatusline(paths.claudeDir)).toEqual({ state: 'foreign', command: 'ccusage statusline' })
  })

  test('a settings file that is not JSON reads as absent, not as a crash', () => {
    writeFileSync(join(paths.claudeDir, 'settings.json'), '{ not json')
    expect(inspectStatusline(paths.claudeDir)).toEqual({ state: 'absent' })
  })
})

describe('compareVersions', () => {
  test('orders dotted numbers as numbers, not as text', () => {
    expect(compareVersions('0.4.5', '0.4.5')).toBe(0)
    expect(compareVersions('0.4.6', '0.4.5')).toBeGreaterThan(0)
    expect(compareVersions('0.4.5', '0.4.10')).toBeLessThan(0)
    expect(compareVersions('1.0', '0.9.9')).toBeGreaterThan(0)
    expect(compareVersions('0.4', '0.4.0')).toBe(0)
  })

  test('reads anything that is not a version as older than any version', () => {
    expect(compareVersions('', '0.0.1')).toBeLessThan(0)
    expect(compareVersions('garbage', '0.0.1')).toBeLessThan(0)
  })
})

describe('findLocalSource', () => {
  const pluginDir = () => join(paths.claudeDir, 'plugins', 'cache', 'some-marketplace', 'token-status-line', '0.0.1-abc')

  test('uses the Claude plugin copy when every file is exactly the pinned one', () => {
    writeSource(pluginDir())
    expect(findLocalSource(paths.claudeDir, source)).toBe(pluginDir())
  })

  test('refuses a copy where one file differs, however slightly', () => {
    writeSource(pluginDir(), { ...FILES, 'scripts/tokens_statusline.py': '# badge source, edited\n' })
    expect(findLocalSource(paths.claudeDir, source)).toBeNull()
  })

  test('refuses a copy with a file missing, and finds nothing where there is no plugin', () => {
    const partial = { ...FILES }
    delete partial['scripts/statusline_chain.py']
    writeSource(pluginDir(), partial)
    expect(findLocalSource(paths.claudeDir, source)).toBeNull()
    rmSync(join(paths.claudeDir, 'plugins'), { recursive: true })
    expect(findLocalSource(paths.claudeDir, source)).toBeNull()
  })
})

describe('ensureSource', () => {
  const upstream = (over: Record<string, string> = {}) => {
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      const rel = url.split(`${source.commit}/`)[1]!
      const body = over[rel] ?? FILES[rel]
      return body === undefined ? new Response('nope', { status: 404 }) : new Response(body)
    }) as unknown as typeof fetch
    return { calls, fetchImpl }
  }

  test('downloads from the pinned commit, checks every hash, and keeps the copy', async () => {
    const { calls, fetchImpl } = upstream()
    const got = await ensureSource({ paths, source, fetchImpl })
    expect(got.from).toBe('download')
    expect(calls).toHaveLength(source.files.length)
    expect(calls.every((u) => u.startsWith(`https://raw.githubusercontent.com/example/badge/${source.commit}/`))).toBe(true)
    expect(readFileSync(join(got.dir, 'scripts/install.py'), 'utf8')).toBe(INSTALLER)
  })

  // Five files over a slow link, one after the other, is five timeouts when GitHub is out of reach.
  test('asks for the files together, not one after another', async () => {
    let inFlight = 0
    let most = 0
    const fetchImpl = (async (url: string) => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 20))
      inFlight--
      return new Response(FILES[url.split(`${source.commit}/`)[1]!] ?? '')
    }) as unknown as typeof fetch
    await ensureSource({ paths, source, fetchImpl })
    expect(most).toBe(source.files.length)
  })

  test('the second time it uses the copy it kept, without the network', async () => {
    const first = upstream()
    await ensureSource({ paths, source, fetchImpl: first.fetchImpl })
    const second = upstream()
    const got = await ensureSource({ paths, source, fetchImpl: second.fetchImpl })
    expect(got.from).toBe('cache')
    expect(second.calls).toEqual([])
  })

  test('prefers a verified Claude plugin copy over downloading at all', async () => {
    writeSource(join(paths.claudeDir, 'plugins', 'cache', 'm', 'token-status-line', '1'))
    const { calls, fetchImpl } = upstream()
    const got = await ensureSource({ paths, source, fetchImpl })
    expect(got.from).toBe('plugin')
    expect(calls).toEqual([])
  })

  // The point of the pin: what runs on every render is exactly what was reviewed.
  test('refuses a file whose hash is not the pinned one, and keeps nothing of the download', async () => {
    const { fetchImpl } = upstream({ 'scripts/tokens_statusline.py': '# tampered\n' })
    await expect(ensureSource({ paths, source, fetchImpl })).rejects.toThrow(/does not match its pinned sha256/)
    expect(existsSync(join(paths.cacheDir, 'statusline'))).toBe(false)
  })

  test('says which file when the download fails', async () => {
    const fetchImpl = (async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
    await expect(ensureSource({ paths, source, fetchImpl })).rejects.toThrow(/HTTP 404/)
  })

  // A failure part way through writing must not leave a half-written staging directory in the cache for ever.
  test('leaves no staging directory behind when writing the files fails', async () => {
    // 'a' is written as a file, so 'a/b' cannot be made: the failure comes after one file is down.
    const files = { a: 'file a', 'a/b': 'file b' }
    const broken: SourceSpec = { ...source, files: Object.entries(files).map(([path, body]) => ({ path, sha256: sha(body) })) }
    const fetchImpl = (async (url: string) => new Response(files[url.split(`${source.commit}/`)[1]! as keyof typeof files])) as unknown as typeof fetch
    await expect(ensureSource({ paths, source: broken, fetchImpl })).rejects.toThrow()
    const left = existsSync(join(paths.cacheDir, 'statusline')) ? readdirSync(join(paths.cacheDir, 'statusline')) : []
    expect(left).toEqual([])
  })

  test('a cached copy that was edited since is not trusted, and is fetched again', async () => {
    const first = upstream()
    const got = await ensureSource({ paths, source, fetchImpl: first.fetchImpl })
    writeFileSync(join(got.dir, 'scripts/tokens_statusline.py'), '# edited on disk\n')
    const again = upstream()
    const next = await ensureSource({ paths, source, fetchImpl: again.fetchImpl })
    expect(next.from).toBe('download')
    expect(readFileSync(join(next.dir, 'scripts/tokens_statusline.py'), 'utf8')).toBe(FILES['scripts/tokens_statusline.py']!)
  })
})

describe('addStatusline', () => {
  const deps = () => ({ paths, source, fetchImpl: (async (url: string) => new Response(FILES[url.split(`${source.commit}/`)[1]!] ?? '', { status: FILES[url.split(`${source.commit}/`)[1]!] === undefined ? 404 : 200 })) as unknown as typeof fetch })
  const ranLog = () => readFileSync(join(paths.cacheDir, 'statusline', source.commit, 'ran.log'), 'utf8')

  test('runs the upstream installer and leaves the status line wired', async () => {
    const r = await addStatusline(deps())
    expect(r.action).toBe('installed')
    expect(inspectStatusline(paths.claudeDir).state).toBe('ours')
    expect(readSettings().statusLine.command).toContain(join(paths.claudeDir, 'hooks', 'tokens_statusline.py'))
  })

  // Regression: run from inside a profile's session, CLAUDE_CONFIG_DIR is that profile's
  // directory. The installer follows it and would write the profile's hooks path into the
  // settings file every profile shares, so deleting that profile would break the footer of
  // all the others. The real config directory is where it belongs.
  test('installs into the real config directory, not the profile this runs inside', async () => {
    const profileDir = join(paths.dirsRoot, 'glm')
    mkdirSync(profileDir, { recursive: true })
    const was = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = profileDir
    try {
      await addStatusline(deps())
    } finally {
      if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = was
    }
    expect(ranLog().trim()).toBe(paths.claudeDir)
    expect(existsSync(join(profileDir, 'hooks'))).toBe(false)
  })

  // The Claude plugin's own hook can put a newer badge there. Installing the pinned files over
  // it would be a downgrade the plugin then undoes.
  test('leaves a newer installed version alone', async () => {
    await addStatusline(deps())
    hook('cc-token-statusline-installed.json', '{"version":"9.9.10"}')
    expect((await addStatusline(deps())).action).toBe('already')
    expect(ranLog().trim().split('\n')).toHaveLength(1)
  })

  // "Already installed and working" is not the answer for a footer that sits in a profile.
  test('moves a footer that sits inside a profile\'s directory into the real one', async () => {
    await addStatusline(deps())
    const profileHooks = join(paths.dirsRoot, 'pclaude', 'hooks')
    mkdirSync(profileHooks, { recursive: true })
    writeFileSync(join(profileHooks, 'tokens_statusline.py'), '#')
    settings({ statusLine: { type: 'command', command: `"/bin/sh" "${join(profileHooks, 'tokens_statusline.py')}"` } })
    hook('cc-token-statusline-installed.json', '{"version":"9.9.9"}') // stamped, up to date, and wrongly placed
    const r = await addStatusline(deps())
    expect(r.action).toBe('installed')
    expect(readSettings().statusLine.command).toContain(join(paths.claudeDir, 'hooks', 'tokens_statusline.py'))
    expect(readSettings().statusLine.command).not.toContain('pclaude')
  })

  test('does nothing when it is already installed at the pinned version', async () => {
    await addStatusline(deps())
    // The stub stamps 9.9.9, the pinned version.
    const again = await addStatusline(deps())
    expect(again.action).toBe('already')
    expect(ranLog().trim().split('\n')).toHaveLength(1)
  })

  test('runs the installer again to refresh a copy of another version, or one that no longer works', async () => {
    await addStatusline(deps())
    hook('cc-token-statusline-installed.json', '{"version":"0.0.1"}')
    expect((await addStatusline(deps())).action).toBe('installed')

    rmSync(join(paths.claudeDir, 'hooks', 'tokens_statusline.py'))
    expect((await addStatusline(deps())).action).toBe('installed')
    expect(inspectStatusline(paths.claudeDir)).toMatchObject({ state: 'ours', working: true })
  })

  // The upstream installer treats a status line that already runs the badge as done: it copies
  // the badge, says so, exits 0 and leaves statusLine alone. That is success, not "not wired up".
  test('treats "your status line already reaches the badge" as success, and does not offer it again', async () => {
    const combiner = join(home, 'combine.sh')
    writeFileSync(combiner, '#!/bin/sh\n# runs tokens_statusline.py among others\n', { mode: 0o755 })
    writeFileSync(join(paths.claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: combiner } }))
    const stub = `#!/usr/bin/env python3
import os
cfg = os.environ["CLAUDE_CONFIG_DIR"]
os.makedirs(os.path.join(cfg, "hooks"), exist_ok=True)
open(os.path.join(cfg, "hooks", "tokens_statusline.py"), "w").write("# badge")
print("installed: " + os.path.join(cfg, "hooks", "tokens_statusline.py"))
print("statusLine already reaches the badge through " + "${combiner}" + ", left as it is")
`
    const files = { ...FILES, 'scripts/install.py': stub }
    const combined: SourceSpec = { ...source, files: Object.entries(files).map(([path, body]) => ({ path, sha256: sha(body) })) }
    const fetchImpl = (async (url: string) => new Response(files[url.split(`${source.commit}/`)[1]! as keyof typeof files] ?? '')) as unknown as typeof fetch
    const r = await addStatusline({ paths, source: combined, fetchImpl })
    expect(r.action).toBe('combined')
    expect(readSettings().statusLine.command).toBe(combiner)
    expect(existsSync(join(paths.claudeDir, 'hooks', 'tokens_statusline.py'))).toBe(true)
    expect(await runOffer({ paths, source: combined, fetchImpl }, async () => 'yes')).toEqual({ outcome: 'not-needed' })
  })

  test('reports an installer that fails, with what it said', async () => {
    const failing = { ...FILES, 'scripts/install.py': '#!/usr/bin/env python3\nimport sys\nprint("boom", file=sys.stderr)\nsys.exit(3)\n' }
    const bad: SourceSpec = { ...source, files: Object.entries(failing).map(([path, body]) => ({ path, sha256: sha(body) })) }
    const fetchImpl = (async (url: string) => new Response(failing[url.split(`${source.commit}/`)[1]! as keyof typeof failing] ?? '')) as unknown as typeof fetch
    await expect(addStatusline({ paths, source: bad, fetchImpl })).rejects.toThrow(/boom/)
  })

  test('says what it needs when there is no python', async () => {
    await expect(addStatusline({ ...deps(), env: { PATH: join(home, 'empty') } })).rejects.toThrow(/python3/)
  })
})

describe('removeStatusline', () => {
  const deps = () => ({ paths, source, fetchImpl: (async (url: string) => new Response(FILES[url.split(`${source.commit}/`)[1]!] ?? '')) as unknown as typeof fetch })

  test('asks the upstream installer to undo what it did', async () => {
    await addStatusline(deps())
    const r = await removeStatusline(deps())
    expect(r.action).toBe('removed')
    expect(readSettings().statusLine).toBeUndefined()
    const log = readFileSync(join(paths.cacheDir, 'statusline', source.commit, 'ran.log'), 'utf8')
    expect(log).toContain('--uninstall')
  })

  // The installer's --uninstall leaves a status line that is not its own alone, so it would do
  // nothing here; saying "removed" and remembering a "no" would be wrong on both counts.
  test('does not claim to remove a status line script of the user\'s that calls the badge', async () => {
    const combiner = join(home, 'combine.sh')
    writeFileSync(combiner, '#!/bin/sh\npython3 tokens_statusline.py\n', { mode: 0o755 })
    writeFileSync(join(paths.claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: combiner } }))
    let fetched = 0
    const r = await removeStatusline({ paths, source, fetchImpl: (async () => { fetched++; return new Response('') }) as unknown as typeof fetch })
    expect(r.action).toBe('combined')
    expect(fetched).toBe(0)
    expect(statuslineDeclined(paths)).toBe(false)
    expect(readSettings().statusLine.command).toBe(combiner)
  })

  test('leaves a status line that is not the badge alone, and does not fetch anything for it', async () => {
    settings({ statusLine: { type: 'command', command: 'ccusage statusline' } })
    let fetched = 0
    const r = await removeStatusline({ paths, source, fetchImpl: (async () => { fetched++; return new Response('') }) as unknown as typeof fetch })
    expect(r.action).toBe('not-installed')
    expect(fetched).toBe(0)
    expect(readSettings().statusLine.command).toBe('ccusage statusline')
  })
})

describe('removing it', () => {
  const deps = () => ({ paths, source, fetchImpl: (async (url: string) => new Response(FILES[url.split(`${source.commit}/`)[1]!] ?? '')) as unknown as typeof fetch })

  // Taking it off is an answer. Without this the next `add` would offer it again, default Yes.
  test('counts as saying no, so `add` does not offer it again', async () => {
    await addStatusline(deps())
    expect(statuslineDeclined(paths)).toBe(false)
    await removeStatusline(deps())
    expect(statuslineDeclined(paths)).toBe(true)
  })
})

describe('when the files cannot be had', () => {
  const offline = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch

  test('adding says it needs the network once, and what to do meanwhile', async () => {
    await expect(addStatusline({ paths, source, fetchImpl: offline })).rejects.toThrow(/needs .* once/)
  })

  // The footer is broken and the way to repair it is the same download. Removal must not leave
  // the user with a settings.json that points at a failing command and no way out.
  test('removing says how to take the status line out by hand', async () => {
    const script = join(paths.claudeDir, 'hooks', 'tokens_statusline.py')
    writeFileSync(join(paths.claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `"/bin/sh" "${script}"` } }))
    const err = await removeStatusline({ paths, source, fetchImpl: offline }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain(join(paths.claudeDir, 'settings.json'))
    expect((err as Error).message).toContain('statusLine')
  })
})

describe('finding a python that runs', () => {
  const deps = () => ({ paths, source, fetchImpl: (async (url: string) => new Response(FILES[url.split(`${source.commit}/`)[1]!] ?? '')) as unknown as typeof fetch })
  const realPython = () => findOnPathForTest('python3')
  const bin = (name: string, body: string) => {
    const dir = join(home, `bin-${name}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, name), body)
    chmodSync(join(dir, name), 0o755)
    return dir
  }

  // On a Mac without the Command Line Tools, /usr/bin/python3 is a stub that raises an install
  // dialog and does not run Python. Being an executable file is not the same as working.
  test('skips a python3 that does not run and uses the python behind it', async () => {
    const stub = bin('python3', '#!/bin/sh\nexit 1\n')
    // A wrapper, not a symlink: Apple's own python3 picks its tool by the name it is called as.
    const good = bin('python', `#!/bin/sh\nexec '${realPython()}' "$@"\n`)
    await addStatusline({ ...deps(), env: { PATH: `${stub}:${good}`, HOME: home } })
    expect(inspectStatusline(paths.claudeDir).state).toBe('ours')
  })

  // A profile installed as a command named python3 before that name was reserved would be
  // started with `-c ...` and run as Claude Code.
  test('does not run a ccprovider launcher that happens to be called python3', async () => {
    const launcherDir = join(home, 'bin-launcher')
    mkdirSync(launcherDir, { recursive: true })
    const marker = join(home, 'launcher-ran')
    writeFileSync(join(launcherDir, 'python3'), renderShim(['/bin/sh', '-c', `${findOnPathForTest('touch')} ${marker}`], 'python3'), { mode: 0o755 })
    const good = bin('python', `#!/bin/sh\nexec '${realPython()}' "$@"\n`)
    await addStatusline({ ...deps(), env: { PATH: `${launcherDir}:${good}`, HOME: home } })
    expect(existsSync(marker)).toBe(false)
    expect(inspectStatusline(paths.claudeDir).state).toBe('ours')
  })

  test('says what is wrong when none of them runs, with the Mac remedy', async () => {
    const stub = bin('python3', '#!/bin/sh\nexit 1\n')
    const err = await addStatusline({ ...deps(), env: { PATH: stub, HOME: home } }).catch((e: Error) => e)
    expect((err as Error).message).toMatch(/3\.8/)
    expect((err as Error).message).toContain('xcode-select')
  })

  // Five downloads to learn that the thing they were for cannot run is the wrong order.
  test('checks for python before it downloads anything', async () => {
    let fetched = 0
    const fetchImpl = (async () => { fetched++; throw new TypeError('offline') }) as unknown as typeof fetch
    const err = await addStatusline({ paths, source, fetchImpl, env: { PATH: join(home, 'empty'), HOME: home } }).catch((e: Error) => e)
    expect((err as Error).message).toContain('python3')
    expect(fetched).toBe(0)
  })

  test('probes the interpreter once, not once to check and again to run', async () => {
    const log = join(home, 'probes')
    const dir = bin('python3', `#!/bin/sh\n[ "$1" = "-c" ] && echo probe >> '${log}'\nexec '${realPython()}' "$@"\n`)
    await addStatusline({ ...deps(), env: { PATH: dir, HOME: home } })
    expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)
  })

  test('says the installer timed out, not that it failed with "exit none"', async () => {
    const slow = { ...FILES, 'scripts/install.py': '#!/usr/bin/env python3\nimport time\ntime.sleep(5)\n' }
    const slowSource: SourceSpec = { ...source, files: Object.entries(slow).map(([path, body]) => ({ path, sha256: sha(body) })) }
    const fetchImpl = (async (url: string) => new Response(slow[url.split(`${source.commit}/`)[1]! as keyof typeof slow] ?? '')) as unknown as typeof fetch
    const err = await addStatusline({ paths, source: slowSource, fetchImpl, timeoutMs: 400 }).catch((e: Error) => e)
    expect((err as Error).message).toContain('timed out')
  })
})

function findOnPathForTest(cmd: string): string {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = join(dir, cmd)
    if (existsSync(p)) return p
  }
  throw new Error(`${cmd} not found`)
}

describe('the offer made by `add`', () => {
  const deps = () => ({ paths, source, fetchImpl: (async (url: string) => new Response(FILES[url.split(`${source.commit}/`)[1]!] ?? '')) as unknown as typeof fetch })
  const asked: Array<{ broken: boolean; foreign: boolean }> = []
  const answer = (a: 'yes' | 'no' | 'cancel') => async (ctx: { broken: boolean; foreign: boolean }) => (asked.push(ctx), a)
  beforeEach(() => { asked.length = 0 })

  test('asks nothing when the footer is installed and working', async () => {
    await addStatusline(deps())
    expect(await runOffer(deps(), answer('yes'))).toEqual({ outcome: 'not-needed' })
    expect(asked).toEqual([])
  })

  test('asks nothing once the answer was no', async () => {
    declineStatusline(paths)
    expect(await runOffer(deps(), answer('yes'))).toEqual({ outcome: 'not-needed' })
    expect(asked).toEqual([])
  })

  test('asks again about a footer that stopped working, whatever was answered before', async () => {
    await addStatusline(deps())
    declineStatusline(paths)
    rmSync(join(paths.claudeDir, 'hooks', 'tokens_statusline.py'))
    const r = await runOffer(deps(), answer('yes'))
    expect(asked).toEqual([{ broken: true, foreign: false }])
    expect(r.outcome).toBe('installed')
  })

  test('yes installs it, tells the question when another status line is in use', async () => {
    writeFileSync(join(paths.claudeDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'ccusage statusline' } }))
    // The stub installer does not chain, so only the question is checked here.
    const r = await runOffer(deps(), answer('yes'))
    expect(asked).toEqual([{ broken: false, foreign: true }])
    expect(r.outcome).toBe('installed')
  })

  test('no is remembered', async () => {
    expect(await runOffer(deps(), answer('no'))).toEqual({ outcome: 'declined' })
    expect(statuslineDeclined(paths)).toBe(true)
    expect(inspectStatusline(paths.claudeDir).state).toBe('absent')
  })

  // Ctrl-C and Esc leave a prompt; they are not an answer. Remembering one as a refusal would
  // silence the offer for good over a keystroke.
  test('cancelling is not an answer, and is not remembered', async () => {
    expect(await runOffer(deps(), answer('cancel'))).toEqual({ outcome: 'cancelled' })
    expect(statuslineDeclined(paths)).toBe(false)
    expect(inspectStatusline(paths.claudeDir).state).toBe('absent')
  })

  test('an installer that fails is reported, and does not count as a no', async () => {
    const fetchImpl = (async () => new Response('x', { status: 500 })) as unknown as typeof fetch
    const r = await runOffer({ paths, source, fetchImpl }, answer('yes'))
    expect(r.outcome).toBe('failed')
    expect(statuslineDeclined(paths)).toBe(false)
  })
})

describe('remembering an answer', () => {
  // The marker is a convenience. Not being able to write it must not abort `add` after the
  // profile is saved, or leave `rm` failing after the uninstaller has already run.
  test('a plain `add` of a footer that is already there leaves an earlier "no" alone', async () => {
    const deps = { paths, source, fetchImpl: (async (url: string) => new Response(FILES[url.split(`${source.commit}/`)[1]!] ?? '')) as unknown as typeof fetch }
    await addStatusline(deps)
    declineStatusline(paths)
    expect((await addStatusline(deps)).action).toBe('already')
    expect(statuslineDeclined(paths)).toBe(true)
  })

  test('never throws when the config directory cannot be written', async () => {
    mkdirSync(join(home, '.config'), { recursive: true })
    writeFileSync(join(home, '.config', 'ccprovider'), 'a file where the directory should be')
    expect(() => declineStatusline(paths)).not.toThrow()
    expect(statuslineDeclined(paths)).toBe(false)
    expect(await runOffer({ paths, source }, async () => 'no')).toEqual({ outcome: 'declined' })
  })

  test('removing the footer completes even then', async () => {
    const deps = { paths, source, fetchImpl: (async (url: string) => new Response(FILES[url.split(`${source.commit}/`)[1]!] ?? '')) as unknown as typeof fetch }
    await addStatusline(deps)
    mkdirSync(join(home, '.config'), { recursive: true })
    writeFileSync(join(home, '.config', 'ccprovider'), 'blocked')
    expect((await removeStatusline(deps)).action).toBe('removed')
  })
})

describe('being asked once', () => {
  test('a declined offer is remembered, and cleared by adding it', () => {
    expect(statuslineDeclined(paths)).toBe(false)
    declineStatusline(paths)
    expect(statuslineDeclined(paths)).toBe(true)
    expect(readdirSync(dirname(paths.configFile))).toContain('statusline-declined')
  })
})

describe('the source pin', () => {
  test('is a real commit with a hash for every file the installer needs', async () => {
    const { STATUSLINE_SOURCE } = await import('../src/statusline.js')
    expect(STATUSLINE_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(STATUSLINE_SOURCE.files.map((f) => f.path).sort()).toEqual(
      ['.claude-plugin/plugin.json', 'LICENSE', 'scripts/install.py', 'scripts/statusline_chain.py', 'scripts/tokens_statusline.py'],
    )
    for (const f of STATUSLINE_SOURCE.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  // Moving the pin means re-taking every hash: this checks them all against GitHub.
  test.skipIf(!process.env.CCPROVIDER_NETWORK_TESTS)('every pinned hash is the file at that commit', async () => {
    const { STATUSLINE_SOURCE: s } = await import('../src/statusline.js')
    for (const f of s.files) {
      const res = await fetch(`https://raw.githubusercontent.com/${s.repo}/${s.commit}/${f.path}`)
      expect(res.ok).toBe(true)
      expect(sha(await res.text())).toBe(f.sha256)
    }
  })
})


import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { getPaths, type Paths } from '../src/paths.js'
import { loadStore, saveStore } from '../src/profile.js'
import { FileStore } from '../src/secrets/file.js'
import { installDefaultShim, installShim } from '../src/shim.js'

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

describe('env --format', () => {
  const KEY = 'sk-test-0123456789abcdef'
  // The CLI under test reads its key from the same encrypted file this writes.
  beforeEach(() => new FileStore(dirname(paths.configFile)).set('glm', KEY))

  /** stdout only: stderr carries notes, and a pipe is what makes the token real, not redacted. */
  const stdout = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' })
    return { status: r.status, out: r.stdout, err: r.stderr.replace(/\x1b\[[0-9;]*m/g, '') }
  }

  test('without --format it is still the `export` listing, config dir and all', () => {
    const r = stdout('env', 'glm')
    expect(r.status).toBe(0)
    expect(r.out).toContain(`export ANTHROPIC_AUTH_TOKEN='${KEY}'`)
    expect(r.out).toContain('export CLAUDE_CONFIG_DIR=')
  })

  test('dotenv is what `docker run --env-file` reads, minus the host config dir', () => {
    const r = stdout('env', 'glm', '--format', 'dotenv')
    expect(r.status).toBe(0)
    expect(r.out).toContain(`ANTHROPIC_AUTH_TOKEN=${KEY}\n`)
    expect(r.out).toContain('ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic\n')
    expect(r.out).not.toContain('CLAUDE_CONFIG_DIR')
    expect(r.out).not.toContain('export')
    expect(r.out).toContain('ANTHROPIC_API_KEY=\n')
  })

  test('dotenv warns, without printing the value, about a value a Compose-style parser would change', async () => {
    await new FileStore(dirname(paths.configFile)).set('glm', 'tok #hidden-part')
    const r = stdout('env', 'glm', '--format', 'dotenv')
    expect(r.status).toBe(0)
    expect(r.out).toContain('ANTHROPIC_AUTH_TOKEN=tok #hidden-part\n') // still raw, for docker run
    expect(r.err).toContain('ANTHROPIC_AUTH_TOKEN')
    expect(r.err).toContain('docker run --env-file')
    expect(r.err).not.toContain('hidden-part')
  })

  test('json parses, and carries the model mapping an SDK needs', () => {
    const r = stdout('env', 'glm', '--format', 'json')
    expect(r.status).toBe(0)
    const parsed = JSON.parse(r.out)
    expect(parsed.ANTHROPIC_AUTH_TOKEN).toBe(KEY)
    expect(parsed.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('m')
    expect(parsed.CLAUDE_CONFIG_DIR).toBeUndefined()
  })

  test('an unknown format is refused, naming the choices', () => {
    const r = stdout('env', 'glm', '--format', 'yaml')
    expect(r.status).toBe(1)
    expect(r.err).toContain('sh, dotenv, json')
    expect(r.out).toBe('')
  })

  // A subscription profile exports nothing but its config dir, and a container has no use
  // for that. Printing an empty file would look like success and fail later in the container.
  test('dotenv and json refuse a subscription profile instead of printing nothing', () => {
    saveStore(paths, { version: 1, providers: { work: { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude' } } })
    for (const format of ['dotenv', 'json']) {
      const r = stdout('env', 'work', '--format', format)
      expect(r.status).toBe(1)
      expect(r.err).toContain('subscription')
      expect(r.out).toBe('')
    }
  })
})

describe('default', () => {
  const KEY = 'sk-test-0123456789abcdef'
  let defaultBin: string
  let real: string // a stand-in for Claude Code that reports how it was started
  beforeEach(async () => {
    await new FileStore(dirname(paths.configFile)).set('glm', KEY)
    defaultBin = paths.defaultBinDir
    mkdirSync(join(home, 'real'))
    real = join(home, 'real', 'claude')
    writeFileSync(real, '#!/bin/sh\nprintf "URL=%s\\nCFG=%s\\n" "$ANTHROPIC_BASE_URL" "$CLAUDE_CONFIG_DIR"\nprintf "ARG=%s\\n" "$@"\n', { mode: 0o755 })
  })

  /** Typing `claude` in a shell whose PATH is exactly `dirs`, plus the system's. */
  const typeClaude = (dirs: string[], ...args: string[]) => {
    const r = spawnSync(join(defaultBin, 'claude'), args, {
      env: { ...env, PATH: [...dirs, '/usr/bin', '/bin'].join(':') },
      encoding: 'utf8',
      timeout: 20_000,
    })
    return { status: r.status, signal: r.signal, out: r.stdout, err: r.stderr }
  }

  test('makes `claude` run the profile, with the arguments untouched', () => {
    const r = run('default', 'glm')
    expect(r.status).toBe(0)
    expect(r.out).toContain('`claude` now runs the "glm" profile')

    const t = typeClaude([defaultBin, join(home, 'real')], '--resume', 'a b')
    expect(t.status).toBe(0)
    expect(t.out).toContain('URL=https://api.z.ai/api/anthropic')
    expect(t.out).toContain(`CFG=${join(home, 'data', 'ccprovider', 'dirs', 'glm')}`)
    expect(t.out).toContain('ARG=--resume\nARG=a b\n')
  })

  // Regression: the wrapper is called `claude` and `use` looks `claude` up on PATH. With the
  // wrapper's directory first and nothing behind it, that was an endless loop.
  // A `claude` run inside a session (a hook, a subagent's shell) is the real one with that
  // session's provider, not the default wrapper pulling it onto the default profile. PATH is
  // left alone: the directory may hold other tools, and `doctor` run from inside must see it.
  test('inside a ccprovider session, passes through to the real claude with that session\'s environment', () => {
    writeFileSync(real, '#!/bin/sh\nprintf "URL=%s\\nCFG=%s\\n" "$ANTHROPIC_BASE_URL" "$CLAUDE_CONFIG_DIR"\n', { mode: 0o755 })
    run('default', 'glm')
    const nested = spawnSync(join(defaultBin, 'claude'), [], {
      env: { ...env, PATH: [defaultBin, join(home, 'real'), '/usr/bin', '/bin'].join(':'), CCPROVIDER_SESSION: '1', ANTHROPIC_BASE_URL: 'https://the-session.example', CLAUDE_CONFIG_DIR: '/the/session/dir' },
      encoding: 'utf8',
    })
    expect(nested.stdout).toContain('URL=https://the-session.example')
    expect(nested.stdout).toContain('CFG=/the/session/dir')
    // Outside a session the same wrapper does what it is for.
    const outside = typeClaude([defaultBin, join(home, 'real')])
    expect(outside.out).toContain('URL=https://api.z.ai/api/anthropic')
  })

  test('leaves PATH as it was, so the directory\'s other tools are still there', () => {
    writeFileSync(real, '#!/bin/sh\nprintf "PATH=%s\\n" "$PATH"\n', { mode: 0o755 })
    run('default', 'glm')
    const line = typeClaude([defaultBin, join(home, 'real')]).out.split('\n').find((l) => l.startsWith('PATH='))!
    expect(line.slice(5).split(':')).toContain(defaultBin)
  })

  test('marks the session it starts, so a nested default wrapper knows it is inside one', () => {
    writeFileSync(real, '#!/bin/sh\nprintf "SESSION=%s\\n" "$CCPROVIDER_SESSION"\n', { mode: 0o755 })
    run('default', 'glm')
    expect(typeClaude([defaultBin, join(home, 'real')]).out).toContain('SESSION=1')
  })

  test('does not call itself when the real claude is missing', () => {
    run('default', 'glm')
    const t = typeClaude([defaultBin])
    expect(t.signal).toBeNull() // not killed by the timeout
    expect(t.status).toBe(1)
    expect(t.err).toContain('Install Claude Code')
  })

  test('says what is still in the way when the real claude comes first on PATH', () => {
    const r = spawnSync(process.execPath, [CLI, 'default', 'glm'], {
      env: { ...env, PATH: `${join(home, 'real')}:/usr/bin:/bin` },
      encoding: 'utf8',
    })
    const out = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '')
    expect(r.status).toBe(0)
    expect(out).toContain(`still runs ${real}`)
    expect(out).toContain(`export PATH="${defaultBin}:$PATH"`)
  })

  test('with no argument, says which profile it is, or that there is none', () => {
    expect(run('default').out).toContain('No default profile')
    run('default', 'glm')
    expect(run('default').out).toContain('`claude` runs the "glm" profile')
  })

  test('--off puts the real claude back', () => {
    run('default', 'glm')
    const r = run('default', '--off')
    expect(r.status).toBe(0)
    expect(existsSync(join(defaultBin, 'claude'))).toBe(false)
    expect(run('default', '--off').out).toContain('No default profile')
  })

  test('refuses a profile that does not exist, and a profile together with --off', () => {
    const missing = run('default', 'nope')
    expect(missing.status).toBe(1)
    expect(missing.out).toContain('nope')
    expect(existsSync(join(defaultBin, 'claude'))).toBe(false)
    expect(run('default', 'glm', '--off').status).toBe(1)
  })

  test('leaves a claude it did not write', () => {
    mkdirSync(defaultBin, { recursive: true })
    writeFileSync(join(defaultBin, 'claude'), '#!/bin/sh\necho mine\n', { mode: 0o755 })
    const r = run('default', 'glm')
    expect(r.status).toBe(1)
    expect(r.out).toContain('was not created by ccprovider')
    expect(readFileSync(join(defaultBin, 'claude'), 'utf8')).toBe('#!/bin/sh\necho mine\n')
  })
})

describe('usage', () => {
  const T0 = Date.UTC(2026, 9, 10, 12, 0, 0) / 1000
  const line = (id: string, model: string, usage: Record<string, number>, at = T0) =>
    JSON.stringify({ type: 'assistant', message: { id, model, content: [{ type: 'text', text: 'private' }], usage }, timestamp: new Date(at * 1000).toISOString() })
  let glmProjects: string
  let transcript: string

  beforeEach(() => {
    glmProjects = join(home, 'data', 'ccprovider', 'dirs', 'glm', 'projects')
    mkdirSync(join(glmProjects, '-work-app', 's1', 'subagents'), { recursive: true })
    transcript = join(glmProjects, '-work-app', 's1.jsonl')
    writeFileSync(
      transcript,
      [
        line('msg_1', 'glm-5.3', { input_tokens: 0, output_tokens: 0 }),
        line('msg_1', 'glm-5.3', { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 200 }),
        line('msg_2', 'glm-5.3', { input_tokens: 10, output_tokens: 5 }),
      ].join('\n') + '\n',
    )
    writeFileSync(join(glmProjects, '-work-app', 's1', 'subagents', 'agent-a.jsonl'), line('msg_3', 'glm-5.3-flash', { input_tokens: 7, output_tokens: 3 }) + '\n')
  })

  const json = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, 'usage', ...args, '--json'], { env, encoding: 'utf8' })
    return { status: r.status, data: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr }
  }

  test('adds up each model of a profile, subagents included, one call counted once', () => {
    const r = json('glm')
    expect(r.status).toBe(0)
    expect(r.data.rows).toEqual([
      { profile: 'glm', model: 'glm-5.3', calls: 2, input: 1010, output: 55, cacheRead: 4000, cacheWrite: 200, cacheReported: true },
      { profile: 'glm', model: 'glm-5.3-flash', calls: 1, input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cacheReported: false },
    ])
    expect(r.data.unreadableLines).toBe(0)
  })

  test('prints a table for a person, with the hit rate', () => {
    const r = run('usage', 'glm')
    expect(r.status).toBe(0)
    expect(r.out).toContain('glm-5.3-flash')
    expect(r.out).toContain('cache hit')
    // 4000 / (1010 + 4000 + 200) = 77%
    expect(r.out).toMatch(/glm-5\.3\s+2\s+1\.0K\s+55\s+4\.0K\s+200\s+77%/)
  })

  test('without a name, covers every profile that has used anything, and only those', () => {
    saveStore(paths, { version: 1, providers: { ...loadStore(paths).providers, idle: { baseUrl: 'https://x.dev', aliases: {} } } as never })
    const r = json()
    expect(new Set(r.data.rows.map((x: { profile: string }) => x.profile))).toEqual(new Set(['glm']))
  })

  test('keeps a ledger, private to the user, and a second run reads the same numbers from it', () => {
    json('glm')
    const ledger = join(home, 'data', 'ccprovider', 'usage', 'glm.json')
    expect(statSync(ledger).mode & 0o777).toBe(0o600)
    expect(json('glm').data.rows[0].calls).toBe(2)
  })

  test('still counts what Claude Code has deleted since, until --rebuild', () => {
    json('glm')
    rmSync(glmProjects, { recursive: true })
    expect(json('glm').data.rows.reduce((n: number, r: { calls: number }) => n + r.calls, 0)).toBe(3)
    expect(json('glm', '--rebuild').data.rows).toEqual([])
  })

  test('--rebuild keeps the ledger it replaces, since it was the only record of deleted transcripts', () => {
    json('glm')
    rmSync(glmProjects, { recursive: true })
    const r = spawnSync(process.execPath, [CLI, 'usage', 'glm', '--rebuild', '--json'], { env, encoding: 'utf8' })
    expect(JSON.parse(r.stdout).rows).toEqual([])
    const backup = join(home, 'data', 'ccprovider', 'usage', 'glm.json.bak')
    expect(statSync(backup).mode & 0o777).toBe(0o600)
    expect(Object.keys(JSON.parse(readFileSync(backup, 'utf8')).calls).sort()).toEqual(['msg_1', 'msg_2', 'msg_3'])
    expect(r.stderr).toContain('glm.json.bak')
  })

  const ledgerFile = () => join(home, 'data', 'ccprovider', 'usage', 'glm.json')

  // The ledger is the only record of transcripts Claude Code has since deleted. One that can
  // not be read is set aside, never written over.
  test('a ledger that cannot be read is set aside, and the profile is read afresh', () => {
    json('glm')
    writeFileSync(ledgerFile(), '{"version":1,"files":{"a":')
    const r = spawnSync(process.execPath, [CLI, 'usage', 'glm', '--json'], { env, encoding: 'utf8' })
    expect(JSON.parse(r.stdout).rows).toHaveLength(2)
    expect(readFileSync(`${ledgerFile()}.damaged`, 'utf8')).toBe('{"version":1,"files":{"a":')
    expect(statSync(`${ledgerFile()}.damaged`).mode & 0o777).toBe(0o600)
    expect(r.stderr).toContain('glm.json.damaged')
  })

  test('a ledger from a newer ccprovider is left untouched, and the run reports without saving', () => {
    json('glm')
    const newer = JSON.stringify({ version: 2, files: {}, calls: { msg_future: ['m', 1, 1, 1, null, null] } })
    writeFileSync(ledgerFile(), newer)
    const r = spawnSync(process.execPath, [CLI, 'usage', 'glm', '--json'], { env, encoding: 'utf8' })
    expect(JSON.parse(r.stdout).rows).toHaveLength(2) // from the transcripts that are still there
    expect(r.stderr).toContain('newer ccprovider')
    expect(readFileSync(ledgerFile(), 'utf8')).toBe(newer)
    expect(existsSync(`${ledgerFile()}.damaged`)).toBe(false)
  })

  // A second rebuild would copy the already-shrunk ledger over the one copy that still holds the history.
  test('--rebuild twice keeps the copy that holds more', () => {
    json('glm')
    rmSync(glmProjects, { recursive: true })
    json('glm', '--rebuild')
    json('glm', '--rebuild')
    const backup = JSON.parse(readFileSync(`${ledgerFile()}.bak`, 'utf8'))
    expect(Object.keys(backup.calls)).toHaveLength(3)
  })

  // Transcripts with nothing countable in them still have to be remembered, or every run
  // reads them all again from the first byte.
  test('remembers transcripts that held no countable call, so they are not read again', () => {
    rmSync(glmProjects, { recursive: true })
    mkdirSync(join(glmProjects, '-x'), { recursive: true })
    writeFileSync(join(glmProjects, '-x', 's.jsonl'), JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n')
    expect(json('glm').data.rows).toEqual([])
    const saved = JSON.parse(readFileSync(ledgerFile(), 'utf8'))
    expect(saved.files['-x/s.jsonl'].offset).toBeGreaterThan(0)
  })

  test('a line that could not be read stays reported on later runs, and in --json', () => {
    appendFileSync(transcript, '{"type":"assistant","message":{"id":"msg_bad","usage":{"input_tok\n')
    expect(json('glm').data.unreadableLines).toBe(1)
    expect(json('glm').data.unreadableLines).toBe(1)
    expect(run('usage', 'glm').out).toContain('1 line')
  })

  test('--since and --by day', () => {
    expect(json('glm', '--since', '2099-01-01').data.rows).toEqual([])
    expect(json('glm', '--since', '2000-01-01').data.rows).toHaveLength(2)
    const byDay = json('glm', '--by', 'day').data.rows
    expect(byDay.map((r: { day: string }) => r.day)).toEqual(['2026-10-10', '2026-10-10'])
  })

  test('refuses what it does not understand, and a profile that does not exist', () => {
    for (const args of [['glm', '--since', 'yesterday'], ['glm', '--by', 'week'], ['nope']]) {
      const r = spawnSync(process.execPath, [CLI, 'usage', ...args], { env, encoding: 'utf8' })
      expect(r.status).toBe(1)
      expect(r.stdout).toBe('')
    }
  })

  test('says so when a profile has never run', () => {
    rmSync(glmProjects, { recursive: true })
    expect(run('usage', 'glm').out).toContain('No usage')
  })

  test('labels a Claude subscription profile', () => {
    saveStore(paths, { version: 1, providers: { work: { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude' } } })
    const dir = join(home, 'data', 'ccprovider', 'dirs', 'work', 'projects', '-x')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 's.jsonl'), line('msg_9', 'claude-opus-5-5', { input_tokens: 5, output_tokens: 5 }) + '\n')
    expect(run('usage').out).toContain('Claude subscription')
  })
})

describe('removing the profile the token footer runs from', () => {
  test('says so, since the status bar would go in every profile', () => {
    const hooks = join(home, 'data', 'ccprovider', 'dirs', 'glm', 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'tokens_statusline.py'), '#')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `"/bin/sh" "${join(hooks, 'tokens_statusline.py')}"` } }))
    const r = run('rm', 'glm', '-y')
    expect(r.status).toBe(0)
    expect(r.out).toContain('token footer')
    expect(r.out).toContain('ccprovider statusline add')
  })
})

describe('options that belong to one command', () => {
  // Silently ignored, `usage --format json` printed the table with exit 0 and a script piped it to jq.
  test.each([
    [['usage', '--format', 'json'], '--format'],
    [['doctor', '--json'], '--json'],
    [['env', 'glm', '--since', '7d'], '--since'],
    [['ls', '--rebuild'], '--rebuild'],
    [['usage', '--off'], '--off'],
    [['ls', '--no-statusline'], '--no-statusline'],
  ])('%j is refused, naming the flag', (args, flag) => {
    const r = run(...args)
    expect(r.status).toBe(1)
    expect(r.out).toContain(flag)
    expect(r.out).toContain('only')
  })

  test('and still accepted where it belongs', () => {
    expect(run('usage', 'glm', '--json').status).toBe(0)
  })
})

describe('doctor with no profiles', () => {
  // The install-wide findings do not depend on any profile existing: a default `claude` that
  // names a profile that is gone fails every time it is typed.
  test('still reports a default wrapper whose profile is gone', () => {
    saveStore(paths, { version: 1, providers: {} })
    installDefaultShim(paths, 'ghost', ['/bin/true'])
    const r = run('doctor')
    expect(r.status).toBe(1)
    expect(r.out).toContain('No profiles yet')
    expect(r.out).toContain('"ghost"')
  })

  test('is quiet and fine when there is nothing at all', () => {
    saveStore(paths, { version: 1, providers: {} })
    const r = run('doctor')
    expect(r.status).toBe(0)
    expect(r.out).toContain('No profiles yet')
  })
})

describe('statusline', () => {
  const claude = () => join(home, '.claude')
  const settings = (command: string) => {
    mkdirSync(claude(), { recursive: true })
    writeFileSync(join(claude(), 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command } }))
  }

  test('says it is not installed, and how to install it', () => {
    const r = run('statusline')
    expect(r.status).toBe(0)
    expect(r.out).toContain('not installed')
    expect(r.out).toContain('ccprovider statusline add')
  })

  test('says when something else is the status line, and that adding wraps it', () => {
    settings('ccusage statusline')
    const r = run('statusline')
    expect(r.out).toContain('ccusage statusline')
    expect(r.out).toContain('after it')
  })

  test('says it works, with the version, when the badge is wired', () => {
    mkdirSync(join(claude(), 'hooks'), { recursive: true })
    writeFileSync(join(claude(), 'hooks', 'tokens_statusline.py'), '#')
    writeFileSync(join(claude(), 'hooks', 'cc-token-statusline-installed.json'), '{"version":"0.4.5"}')
    settings(`"/bin/sh" "${join(claude(), 'hooks', 'tokens_statusline.py')}"`)
    const r = run('statusline')
    expect(r.out).toContain('installed')
    expect(r.out).toContain('0.4.5')
  })

  test('does not tell the owner of a status line script that calls the badge to update it', () => {
    const combiner = join(home, 'combine.sh')
    writeFileSync(combiner, '#!/bin/sh\npython3 tokens_statusline.py\n', { mode: 0o755 })
    mkdirSync(join(claude(), 'hooks'), { recursive: true })
    writeFileSync(join(claude(), 'hooks', 'cc-token-statusline-installed.json'), '{"version":"0.0.1"}')
    settings(combiner)
    const r = run('statusline')
    expect(r.out).toContain('your own status line script')
    expect(r.out).not.toContain('updates it')
  })

  test('calls out a footer whose script is gone, since that hides the status bar', () => {
    settings(`"/bin/sh" "${join(claude(), 'hooks', 'tokens_statusline.py')}"`)
    const r = run('statusline')
    expect(r.out).toContain('missing')
    expect(r.out).toContain('ccprovider statusline add')
  })

  test('rm with nothing installed changes nothing', () => {
    settings('ccusage statusline')
    const r = run('statusline', 'rm')
    expect(r.status).toBe(0)
    expect(r.out).toContain('not installed')
    expect(readFileSync(join(claude(), 'settings.json'), 'utf8')).toContain('ccusage statusline')
  })

  test('refuses a subcommand it does not know', () => {
    const r = run('statusline', 'enable')
    expect(r.status).toBe(1)
    expect(r.out).toContain('add')
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

describe('settings', () => {
  test('bare shows the global default and how each profile resolves', () => {
    const r = run('settings')
    expect(r.status).toBe(0)
    expect(r.out).toContain('shareSessions  false')
    expect(r.out).toContain('glm')
    expect(r.out).toContain('inherits — isolated')
  })

  test('set flips the global; a per-profile override beats it; unset inherits again', () => {
    expect(run('settings', 'set', 'shareSessions', 'true').status).toBe(0)
    expect(run('settings').out).toContain('shareSessions  true')
    expect(run('settings').out).toContain('inherits — shares with ~/.claude')
    expect(run('settings', 'set', 'shareSessions', 'false', 'glm').status).toBe(0)
    expect(run('settings').out).toContain('own override')
    expect(run('settings', 'unset', 'shareSessions', 'glm').status).toBe(0)
    expect(run('settings').out).toContain('inherits — shares with ~/.claude')
  })

  // The menu needs a terminal. Piped, as in a script or here, the list is all there is, so it
  // has to say how to change something instead of leaving the reader to find the syntax.
  test('bare, without a terminal, ends with how to change it', () => {
    const r = run('settings')
    expect(r.status).toBe(0)
    expect(r.out).toContain('ccprovider settings set shareSessions true|false [profile]')
  })

  test('a subscription profile never shares', () => {
    saveStore(paths, { version: 1, providers: { work: { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude' } } })
    const r = run('settings', 'set', 'shareSessions', 'true', 'work')
    expect(r.status).toBe(1)
    expect(r.out).toContain('login')
    // Nothing to drop, and a loop over every profile must not stop here.
    expect(run('settings', 'unset', 'shareSessions', 'work').status).toBe(0)
  })

  // An empty "$PROFILE" in a script is not "no profile": it must not change every profile's default.
  test('an empty profile name is refused, not read as the global setting', () => {
    expect(run('settings', 'set', 'shareSessions', 'true', '').status).toBe(1)
    expect(existsSync(join(home, 'config', 'ccprovider', 'settings.json'))).toBe(false)
  })

  test('the hint for changing a setting goes to stderr, so stdout stays the list', () => {
    const r = spawnSync(process.execPath, [CLI, 'settings'], { env, encoding: 'utf8' })
    const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '')
    expect(plain(r.stdout)).toContain('shareSessions  false')
    expect(plain(r.stdout)).not.toContain('change:')
    expect(plain(r.stderr)).toContain('change:')
  })

  test('setting what is already set says so instead of announcing a change', () => {
    expect(run('settings', 'set', 'shareSessions', 'true', 'glm').out).toContain('now shares')
    expect(run('settings', 'set', 'shareSessions', 'true', 'glm').out).toContain('already shares')
    expect(run('settings', 'unset', 'shareSessions', 'glm').out).toContain('follows the global setting again')
    expect(run('settings', 'unset', 'shareSessions', 'glm').out).toContain('no override of its own')
  })

  test('turning sharing on says what happens to the sessions it already has', () => {
    const r = run('settings', 'set', 'shareSessions', 'true', 'glm')
    expect(r.out).toContain('claude --resume')
    expect(r.out).toContain('agents and MCP servers are unavailable')
  })

  test('refuses a key, a value, or arguments it does not understand', () => {
    for (const args of [['set', 'theme', 'dark'], ['set', 'shareSessions', 'maybe'], ['set', 'shareSessions'], ['unset', 'shareSessions'], ['enable']]) {
      expect(run('settings', ...args).status).toBe(1)
    }
  })

  test('the file is private, beside providers.json', () => {
    expect(run('settings', 'set', 'shareSessions', 'true').status).toBe(0)
    const file = join(home, 'config', 'ccprovider', 'settings.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})

describe('sharing sessions', () => {
  const KEY = 'sk-test-0123456789abcdef'
  let fakebin: string
  beforeEach(() => {
    fakebin = join(home, 'fakebin')
    mkdirSync(fakebin)
    writeFileSync(join(fakebin, 'claude'), '#!/bin/sh\nprintf "CFG=%s\\nSESSION=%s\\n" "$CLAUDE_CONFIG_DIR" "$CCPROVIDER_SESSION"\n', { mode: 0o755 })
  })
  /** The CLI with only the fake claude on PATH, so `use` launches that. */
  const useCli = (...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], {
      env: { ...env, PATH: `${fakebin}:/usr/bin:/bin` },
      encoding: 'utf8',
    })
    return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '') }
  }
  const share = () => {
    saveStore(paths, {
      version: 1,
      providers: { glm: { baseUrl: 'https://api.z.ai/api/anthropic', aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' }, shareSessions: true } },
    })
  }
  const line = (id: string, input: number, output: number) =>
    JSON.stringify({ type: 'assistant', message: { id, model: 'glm-5.3', content: [{ type: 'text', text: 'private' }], usage: { input_tokens: input, output_tokens: output } }, timestamp: new Date(Date.UTC(2026, 9, 10, 12) * 1).toISOString() })

  test('an isolated profile launches in its own directory, a shared one in ~/.claude', async () => {
    await new FileStore(dirname(paths.configFile)).set('glm', KEY)
    expect(useCli('use', 'glm').out).toContain(`CFG=${join(home, 'data', 'ccprovider', 'dirs', 'glm')}`)
    expect(useCli('use', 'glm').out).toContain('SESSION=1')
    share()
    expect(useCli('use', 'glm').out).toContain(`CFG=${join(home, '.claude')}`)
  })

  // Measured: unset, Claude Code keeps its global state in ~/.claude.json; set to ~/.claude it
  // moves to ~/.claude/.claude.json. Exporting it for a shared session would split the two.
  test('a shared session leaves CLAUDE_CONFIG_DIR unset when the user never declared one', async () => {
    await new FileStore(dirname(paths.configFile)).set('glm', KEY)
    share()
    const { CLAUDE_CONFIG_DIR: _declared, ...undeclared } = env
    const r = spawnSync(process.execPath, [CLI, 'use', 'glm'], { env: { ...undeclared, PATH: `${fakebin}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect(r.stdout).toContain('CFG=\n')
    const e = spawnSync(process.execPath, [CLI, 'env', 'glm'], { env: { ...undeclared, PATH: `${fakebin}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect(e.stdout).not.toContain('CLAUDE_CONFIG_DIR')
  })

  test('env reports the shared directory too', async () => {
    await new FileStore(dirname(paths.configFile)).set('glm', KEY)
    share()
    const r = useCli('env', 'glm')
    expect(r.status).toBe(0)
    expect(r.out).toContain(`export CLAUDE_CONFIG_DIR='${join(home, '.claude')}'`)
  })

  test('agents refuse while sharing, naming the way out', () => {
    share()
    const r = useCli('agents', 'add', 'glm', 'some-agent')
    expect(r.status).toBe(1)
    expect(r.out).toContain('shares its config directory')
    expect(r.out).toContain('settings set shareSessions false glm')
  })

  test('usage counts the old sessions in the profile dir and the shared directory once', () => {
    share()
    const glmProjects = join(home, 'data', 'ccprovider', 'dirs', 'glm', 'projects')
    mkdirSync(join(glmProjects, '-old'), { recursive: true })
    writeFileSync(join(glmProjects, '-old', 's.jsonl'), line('msg_old', 5, 1) + '\n')
    const sharedProjects = join(home, '.claude', 'projects')
    mkdirSync(join(sharedProjects, '-new'), { recursive: true })
    writeFileSync(join(sharedProjects, '-new', 's.jsonl'), line('msg_new', 7, 2) + '\n')
    const r = spawnSync(process.execPath, [CLI, 'usage', 'glm', '--json'], { env, encoding: 'utf8' })
    expect(JSON.parse(r.stdout).rows).toEqual([
      { profile: 'glm', model: 'glm-5.3', calls: 1, input: 5, output: 1, cacheRead: 0, cacheWrite: 0, cacheReported: false },
      { profile: 'shared', model: 'glm-5.3', calls: 1, input: 7, output: 2, cacheRead: 0, cacheWrite: 0, cacheReported: false },
    ])
  })

  // Regression: the group was keyed `shared`, and a profile can be called that.
  test('a profile named shared is not merged with the shared directory', () => {
    const store = loadStore(paths)
    store.providers.shared = { baseUrl: 'https://x.dev/anthropic', aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' }, shareSessions: false }
    store.providers.glm = { ...store.providers.glm!, shareSessions: true }
    saveStore(paths, store)
    const own = join(home, 'data', 'ccprovider', 'dirs', 'shared', 'projects')
    mkdirSync(join(own, '-own'), { recursive: true })
    writeFileSync(join(own, '-own', 's.jsonl'), line('msg_own', 5, 1) + '\n')
    const sharedProjects = join(home, '.claude', 'projects')
    mkdirSync(join(sharedProjects, '-new'), { recursive: true })
    writeFileSync(join(sharedProjects, '-new', 's.jsonl'), line('msg_new', 7, 2) + '\n')
    const r = spawnSync(process.execPath, [CLI, 'usage', '--json'], { env, encoding: 'utf8' })
    const rows = JSON.parse(r.stdout).rows as Array<{ profile: string; input: number }>
    expect(Object.fromEntries(rows.map((x) => [x.profile, x.input]))).toEqual({ shared: 5, 'shared (~/.claude)': 7 })
  })

  test('two profiles sharing the directory count it once', () => {
    const store = loadStore(paths)
    store.providers.kimi = { baseUrl: 'https://x.dev/anthropic', aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' }, shareSessions: true }
    saveStore(paths, store)
    const sharedProjects = join(home, '.claude', 'projects')
    mkdirSync(join(sharedProjects, '-new'), { recursive: true })
    writeFileSync(join(sharedProjects, '-new', 's.jsonl'), line('msg_new', 7, 2) + '\n')
    const r = spawnSync(process.execPath, [CLI, 'usage', '--json'], { env, encoding: 'utf8' })
    const rows = JSON.parse(r.stdout).rows.filter((x: { profile: string }) => x.profile === 'shared')
    expect(rows).toHaveLength(1)
    expect(rows[0].calls).toBe(1)
  })

  test('ls says a shared profile shares', () => {
    share()
    expect(run('ls').out).toContain('shared with')
  })

  test('doctor reports the shared directory instead of links', () => {
    share()
    const r = useCli('doctor', 'glm')
    expect(r.out).toContain('config directory')
    expect(r.out).toContain('shared with')
    expect(r.out).not.toContain('shared config links')
  })
})

describe('init', () => {
  const rcPath = () => join(home, '.zshrc')
  const initWith = (shell: string | undefined, ...args: string[]) => {
    const r = spawnSync(process.execPath, [CLI, 'init', ...args], {
      env: { ...env, ...(shell ? { SHELL: shell } : {}) },
      encoding: 'utf8',
    })
    return { status: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '') }
  }

  test('-y writes a marker block, and a second run changes nothing', () => {
    const r = initWith('/bin/zsh', '-y')
    expect(r.status).toBe(0)
    const text = readFileSync(rcPath(), 'utf8')
    expect(text).toContain('# >>> ccprovider path >>>')
    expect(text).toContain(`export PATH="${paths.defaultBinDir}:$PATH"`)
    const again = initWith('/bin/zsh', '-y')
    expect(again.out).toContain('already up to date')
    expect(readFileSync(rcPath(), 'utf8')).toBe(text)
  })

  test('without -y and without a terminal it prints what it would add and edits nothing', () => {
    const r = initWith('/bin/zsh')
    expect(r.status).toBe(1)
    expect(existsSync(rcPath())).toBe(false)
    expect(r.out).toContain('export PATH=')
    expect(r.out).toContain('-y')
  })

  test('an unknown shell gets the line to add itself, and nothing is written', () => {
    const r = initWith('/usr/bin/fish')
    expect(r.status).toBe(1)
    expect(r.out).toContain('export PATH=')
    expect(existsSync(rcPath())).toBe(false)
  })

  // Regression: the block was built from the current PATH, and the block is what puts the
  // launchers dir on PATH. The second run, in the shell the first run set up, saw it there
  // and wrote a block without it, so the shell after that lost it again.
  test('a second run from the shell the first one set up keeps the launchers dir', () => {
    const first = spawnSync(process.execPath, [CLI, 'init', '-y'], { env: { ...env, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    expect(first.status).toBe(0)
    const before = readFileSync(rcPath(), 'utf8')
    const again = spawnSync(process.execPath, [CLI, 'init', '-y'], { env: { ...env, SHELL: '/bin/zsh', PATH: `${paths.defaultBinDir}:${paths.binDir}:/usr/bin:/bin` }, encoding: 'utf8' })
    expect(again.status).toBe(0)
    expect(readFileSync(rcPath(), 'utf8')).toBe(before)
    expect(before).toContain(`export PATH="${paths.binDir}:$PATH"`)
  })

  test('binDir off PATH joins the block too', () => {
    const r = spawnSync(process.execPath, [CLI, 'init', '-y'], {
      env: { ...env, SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
    })
    expect(r.status).toBe(0)
    const text = readFileSync(rcPath(), 'utf8')
    expect(text).toContain(`export PATH="${paths.defaultBinDir}:$PATH"`)
    expect(text).toContain(`export PATH="${paths.binDir}:$PATH"`)
  })
})


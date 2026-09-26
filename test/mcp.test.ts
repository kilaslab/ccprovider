import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  claudeRunner,
  compareInstalled,
  definitionsFor,
  HEADERS_HELPER,
  HELPER_KEY_RE,
  readInstalledMcp,
  regionFor,
  registeredIds,
  resolveServers,
  resolveUnwanted,
  serverJson,
  syncMcp,
  type Desired,
  type Run,
} from '../src/mcp.js'
import { findPreset } from '../src/presets.js'
import { validateProfile } from '../src/profile.js'
import type { Profile } from '../src/types.js'

const glm = findPreset('glm')!
const ZAI = glm.mcp!.regions[0]!
const ZHIPU = glm.mcp!.regions[1]!
const spec = (id: string) => glm.mcp!.servers.find((s) => s.id === id)!

const profile = (baseUrl: string, mcp?: string[]): Profile => ({
  baseUrl,
  aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' },
  mcp,
})

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccprov-mcp-')) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the GLM preset', () => {
  test('ships the four documented servers', () => {
    expect(glm.mcp!.servers.map((s) => s.id)).toEqual(['zai-mcp-server', 'web-search-prime', 'web-reader', 'zread'])
  })

  test('every server ID is one validateProfile will accept', () => {
    const ids = glm.mcp!.servers.map((s) => s.id)
    expect(validateProfile({ baseUrl: 'https://api.z.ai/api/anthropic', aliases: {}, mcp: ids }, 't').mcp).toEqual(ids)
  })

  test('the stdio server is pinned to an exact version', () => {
    // Regression guard: an unpinned `npx -y @z_ai/mcp-server` runs whatever npm serves
    // next, with the user's API key in its environment.
    const vision = spec('zai-mcp-server')
    if (vision.kind !== 'stdio') throw new Error('expected stdio')
    expect(vision.args.join(' ')).toMatch(/@z_ai\/mcp-server@\d+\.\d+\.\d+$/)
  })
})

describe('serverJson', () => {
  test('http servers point at the region host and authenticate through the helper', () => {
    expect(serverJson(spec('web-search-prime'), ZAI)).toEqual({
      type: 'http',
      url: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
      headersHelper: HEADERS_HELPER,
    })
    expect(serverJson(spec('zread'), ZHIPU)).toMatchObject({ url: 'https://open.bigmodel.cn/api/mcp/zread/mcp' })
  })

  test('the stdio server takes its mode from the region', () => {
    expect(serverJson(spec('zai-mcp-server'), ZAI)).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@z_ai/mcp-server@0.1.5'],
      env: { Z_AI_API_KEY: '${ANTHROPIC_AUTH_TOKEN}', Z_AI_MODE: 'ZAI' },
    })
    expect((serverJson(spec('zai-mcp-server'), ZHIPU).env as Record<string, string>).Z_AI_MODE).toBe('ZHIPU')
  })

  test('no definition ever contains a key — only references to the session environment', () => {
    // Regression: Z.ai's own installer writes `Bearer <key>` into ~/.claude.json.
    for (const region of [ZAI, ZHIPU]) {
      for (const s of glm.mcp!.servers) {
        const text = JSON.stringify(serverJson(s, region))
        expect(text).not.toMatch(/sk-|Bearer [A-Za-z0-9]/)
      }
    }
  })

  test('never uses ${ANTHROPIC_AUTH_TOKEN} in a remote url or headers', () => {
    // Regression: Claude Code reads that variable as empty there, with no warning, so the
    // server just returns 401. Only `headersHelper` and stdio `env` may reference it.
    for (const s of glm.mcp!.servers.filter((x) => x.kind === 'http')) {
      const j = serverJson(s, ZAI)
      expect(String(j.url)).not.toContain('${')
      expect(j.headers).toBeUndefined()
    }
  })
})

describe('the headers helper (run through a real shell)', () => {
  const run = (token: string | undefined) =>
    spawnSync('sh', ['-c', HEADERS_HELPER], { env: token === undefined ? {} : { ANTHROPIC_AUTH_TOKEN: token }, encoding: 'utf8' })

  test('prints a valid Authorization header for a normal key', () => {
    const r = run('0123456789abcdef.AbCdEfGhIjKl')
    expect(r.status).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual({ Authorization: 'Bearer 0123456789abcdef.AbCdEfGhIjKl' })
  })

  test.each([
    ['a quote that would inject a header', 'x","X-Evil":"y'],
    ['a backslash', 'abc\\def'],
    ['whitespace', 'abc def'],
    ['a newline', 'abc\ndef'],
    ['a dollar sign', 'abc$HOME'],
    ['an empty value', ''],
  ])('refuses %s instead of printing it', (_label, token) => {
    const r = run(token)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
  })

  test('refuses when the variable is not set at all', () => {
    const r = run(undefined)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toBe('')
  })
})

describe('regions and resolution', () => {
  test('regionFor picks by endpoint prefix', () => {
    expect(regionFor('https://api.z.ai/api/anthropic', glm)?.mode).toBe('ZAI')
    expect(regionFor('https://open.bigmodel.cn/api/anthropic', glm)?.mode).toBe('ZHIPU')
    expect(regionFor('https://api.z.ai.evil.example/api/anthropic', glm)).toBeUndefined()
    expect(regionFor('https://litellm.internal/anthropic', glm)).toBeUndefined()
    expect(regionFor('https://api.z.ai/api/anthropic', findPreset('deepseek'))).toBeUndefined()
  })

  test('resolveServers keeps known IDs and reports stale ones', () => {
    const r = resolveServers(profile('https://api.z.ai/api/anthropic', ['zread', 'retired-server']), glm)
    expect(r.servers.map((s) => s.spec.id)).toEqual(['zread'])
    expect(r.unknown).toEqual(['retired-server'])
  })

  test('outside a known region nothing is resolved — better none than a wrong host', () => {
    const r = resolveServers(profile('https://litellm.internal/anthropic', ['zread']), glm)
    expect(r.region).toBeUndefined()
    expect(r.servers).toEqual([])
  })
})

describe('readInstalledMcp', () => {
  const write = (text: string) => writeFileSync(join(dir, '.claude.json'), text)

  test.each([
    ['a missing file', () => {}],
    ['invalid JSON', () => write('{ not json')],
    ['mcpServers of the wrong type', () => write('{"mcpServers":[1,2]}')],
    ['no mcpServers key', () => write('{"projects":{}}')],
  ])('%s is just "nothing installed"', (_label, setup) => {
    setup()
    expect(readInstalledMcp(dir)).toEqual({})
  })

  test('returns what is registered', () => {
    write('{"mcpServers":{"zread":{"type":"http","url":"u"}},"projects":{}}')
    expect(readInstalledMcp(dir)).toEqual({ zread: { type: 'http', url: 'u' } })
  })
})

describe('compareInstalled', () => {
  const want: Desired = { spec: spec('zread'), json: serverJson(spec('zread'), ZAI) }
  test('ok, missing and drift', () => {
    expect(compareInstalled({ zread: want.json }, want)).toBe('ok')
    expect(compareInstalled({}, want)).toBe('missing')
    expect(compareInstalled({ zread: { ...want.json, url: 'https://elsewhere' } }, want)).toBe('drift')
  })

  test('key order does not matter', () => {
    const reordered = Object.fromEntries(Object.entries(want.json).reverse())
    expect(compareInstalled({ zread: reordered }, want)).toBe('ok')
  })
})

describe('syncMcp', () => {
  const desired = (id: string): Desired => ({ spec: spec(id), json: serverJson(spec(id), ZAI) })
  const recorder = (statuses: Array<number | null> = []) => {
    const calls: string[][] = []
    const run: Run = (args) => {
      calls.push(args)
      return { status: statuses.shift() ?? 0, stderr: '' }
    }
    return { calls, run }
  }

  test('adds what is missing, with `claude mcp add-json` at user scope', () => {
    const { calls, run } = recorder()
    const r = syncMcp({ run, installed: {}, wanted: [desired('zread')] })
    expect(r).toEqual([{ id: 'zread', action: 'added' }])
    expect(calls).toEqual([['mcp', 'add-json', '-s', 'user', 'zread', JSON.stringify(desired('zread').json)]])
  })

  test('does nothing for what already matches', () => {
    const { calls, run } = recorder()
    const r = syncMcp({ run, installed: { zread: desired('zread').json }, wanted: [desired('zread')] })
    expect(r).toEqual([{ id: 'zread', action: 'unchanged' }])
    expect(calls).toEqual([])
  })

  test('replaces a drifted definition: remove, then add', () => {
    const { calls, run } = recorder()
    const r = syncMcp({ run, installed: { zread: { type: 'http', url: 'https://old' } }, wanted: [desired('zread')] })
    expect(r).toEqual([{ id: 'zread', action: 'updated' }])
    expect(calls.map((c) => c[1])).toEqual(['remove', 'add-json'])
  })

  test('if the add fails after the remove, the previous definition is put back', () => {
    // Regression guard: without this a failed update leaves the user with neither entry.
    const old = { type: 'http', url: 'https://old' }
    const { calls, run } = recorder([0, 1, 0]) // remove ok, add fails, restore ok
    const r = syncMcp({ run, installed: { zread: old }, wanted: [desired('zread')] })
    expect(r[0]!.action).toBe('failed')
    expect(r[0]!.detail).toContain('previous definition restored')
    expect(calls.at(-1)).toEqual(['mcp', 'add-json', '-s', 'user', 'zread', JSON.stringify(old)])
  })

  test('says so when the restore fails too', () => {
    const { run } = recorder([0, 1, 1])
    const r = syncMcp({ run, installed: { zread: { type: 'http', url: 'https://old' } }, wanted: [desired('zread')] })
    expect(r[0]!.detail).toContain('could not be restored')
  })

  test('a failed first-time add has nothing to restore and does not try', () => {
    const { calls, run } = recorder([1])
    const r = syncMcp({ run, installed: {}, wanted: [desired('zread')] })
    expect(r[0]!.action).toBe('failed')
    expect(calls).toHaveLength(1)
  })

  test('one server failing does not stop the others', () => {
    const { run } = recorder([1, 0])
    const r = syncMcp({ run, installed: {}, wanted: [desired('zread'), desired('web-reader')] })
    expect(r.map((x) => x.action)).toEqual(['failed', 'added'])
  })

  test('a failed remove stops that server there — no add that must fail, no phantom "lost" restore', () => {
    const { calls, run } = recorder([1]) // remove fails
    const old = { type: 'http', url: 'https://old' }
    const r = syncMcp({ run, installed: { zread: old }, wanted: [desired('zread')] })
    expect(r[0]!.action).toBe('failed')
    expect(r[0]!.detail).toContain('could not replace the existing definition')
    expect(calls.map((c) => c[1])).toEqual(['remove']) // never tried add-json, never "restored"
  })

  test('never re-applies a definition holding a credential, since restoring goes through argv', () => {
    // Z.ai's docs tell people to run `claude mcp add --header "Authorization: Bearer <key>"`.
    // Run from inside a profile, that puts a literal key in the very entry we would restore.
    const withKey = { type: 'http', url: 'https://old', headers: { Authorization: 'Bearer sk-live-123' } }
    const { calls, run } = recorder([0, 1]) // remove ok, add fails
    const r = syncMcp({ run, installed: { zread: withKey }, wanted: [desired('zread')] })
    expect(r[0]!.detail).toContain('contains a credential')
    expect(calls).toHaveLength(2) // remove, add — and no third call carrying the key
    expect(JSON.stringify(calls)).not.toContain('sk-live-123')
  })

  describe('servers switched off', () => {
    const gone = (id: string) => resolveUnwanted([id], glm)[0]!

    test('are removed when the installed copy is exactly ours', () => {
      const { calls, run } = recorder()
      const r = syncMcp({ run, installed: { zread: desired('zread').json }, wanted: [], unwanted: [gone('zread')] })
      expect(r).toEqual([{ id: 'zread', action: 'removed' }])
      expect(calls).toEqual([['mcp', 'remove', '-s', 'user', 'zread']])
    })

    test('are removed even when they were written for a different region than the profile is on now', () => {
      // Regression: switching endpoint region and unticking a server in one edit compared
      // the old-region entry against a new-region definition, called it "customised", and
      // left it registered against the old host.
      const zhipuEntry = serverJson(spec('zread'), ZHIPU)
      const { calls, run } = recorder()
      const r = syncMcp({ run, installed: { zread: zhipuEntry }, wanted: [], unwanted: [gone('zread')] })
      expect(r).toEqual([{ id: 'zread', action: 'removed' }])
      expect(calls).toHaveLength(1)
    })

    test('are kept when the user has customised them since', () => {
      const { calls, run } = recorder()
      const custom = { ...desired('zread').json, url: 'https://my-own-proxy/mcp' }
      const r = syncMcp({ run, installed: { zread: custom }, wanted: [], unwanted: [gone('zread')] })
      expect(r[0]!.action).toBe('kept')
      expect(calls).toEqual([])
    })

    test('are ignored when they were never installed', () => {
      const { calls, run } = recorder()
      expect(syncMcp({ run, installed: {}, wanted: [], unwanted: [gone('zread')] })).toEqual([])
      expect(calls).toEqual([])
    })

    test('a failing remove is reported, not counted as removed', () => {
      const { run } = recorder([1])
      const r = syncMcp({ run, installed: { zread: desired('zread').json }, wanted: [], unwanted: [gone('zread')] })
      expect(r[0]!.action).toBe('failed')
    })
  })
})

describe('registeredIds and resolveUnwanted', () => {
  test('finds preset servers registered exactly as we write them, in either region', () => {
    const installed = {
      zread: serverJson(spec('zread'), ZAI),
      'web-reader': serverJson(spec('web-reader'), ZHIPU),
      'web-search-prime': { type: 'http', url: 'https://mine.example/mcp' }, // customised: not ours
      'someone-elses': { type: 'stdio', command: 'x' }, // not a preset server at all
    }
    expect(registeredIds(installed, glm).sort()).toEqual(['web-reader', 'zread'])
  })

  test('definitionsFor gives one definition per region', () => {
    const urls = definitionsFor(spec('zread'), glm).map((d) => d.url)
    expect(urls).toEqual(['https://api.z.ai/api/mcp/zread/mcp', 'https://open.bigmodel.cn/api/mcp/zread/mcp'])
  })

  test('IDs the preset does not define cannot be recognised, so they are not removal candidates', () => {
    expect(resolveUnwanted(['zread', 'retired'], glm).map((u) => u.spec.id)).toEqual(['zread'])
    expect(resolveUnwanted(['zread'], undefined)).toEqual([])
  })
})

describe('HELPER_KEY_RE stays in step with the shell helper', () => {
  test.each([
    ['0123456789abcdef.AbCdEfGhIjKl', true],
    ['a-b_c~d+e/f=g', true],
    ['', false],
    ['has space', false],
    ['quote"quote', false],
    ['back\\slash', false],
    ['dollar$x', false],
    ['percent%s', false],
    ['tab\there', false],
    ['naïve', false],
  ])('%j', (token, accepted) => {
    // Regression guard: doctor warns from the regexp, the servers fail from the snippet.
    // If they disagree, either a healthy key is flagged or a broken one passes.
    expect(HELPER_KEY_RE.test(token)).toBe(accepted)
    const r = spawnSync('sh', ['-c', HEADERS_HELPER], { env: { ANTHROPIC_AUTH_TOKEN: token }, encoding: 'utf8' })
    expect(r.status === 0).toBe(accepted)
  })
})

const hasClaude = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0

describe.skipIf(!hasClaude)('against the real claude (skipped when it is not installed)', () => {
  test('what add-json stores compares equal to what we wrote', () => {
    // The drift check compares the stored definition to ours field for field. If a Claude
    // Code release starts adding default fields, every server would show as drifted
    // forever and edit could never clear it — this is where that would show up first.
    const cfg = join(dir, 'cfg')
    mkdirSync(cfg)
    const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, CLAUDE_CONFIG_DIR: cfg }
    for (const region of [ZAI, ZHIPU]) {
      for (const s of glm.mcp!.servers) {
        const json = serverJson(s, region)
        const add = spawnSync('claude', ['mcp', 'add-json', '-s', 'user', s.id, JSON.stringify(json)], { env, encoding: 'utf8' })
        expect(add.status).toBe(0)
        const installed = readInstalledMcp(cfg)
        expect(compareInstalled(installed, { spec: s, json })).toBe('ok')
        spawnSync('claude', ['mcp', 'remove', '-s', 'user', s.id], { env })
      }
    }
  }, 120_000) // 16 real claude invocations; the default 5s budget is far too small
})

describe('claudeRunner', () => {
  test('runs claude with the profile as its config dir and no credentials', () => {
    // Regression guard: `mcp add-json` never talks to a provider, so the API key has no
    // business being in its environment.
    const out = join(dir, 'env.out')
    const fakeClaude = join(dir, 'claude')
    writeFileSync(fakeClaude, `#!/bin/sh\nenv > '${out}'\nprintf '%s\\n' "$@" > '${out}.args'\n`, { mode: 0o755 })
    mkdirSync(join(dir, 'profile'))

    const base = { PATH: process.env.PATH, HOME: '/home/x', ANTHROPIC_AUTH_TOKEN: 'sk-leak', ANTHROPIC_BASE_URL: 'https://x', AWS_SECRET_ACCESS_KEY: 'aws' }
    const r = claudeRunner(fakeClaude, join(dir, 'profile'), base)(['mcp', 'list'])

    expect(r.status).toBe(0)
    const env = readFileSync(out, 'utf8')
    expect(env).toContain(`CLAUDE_CONFIG_DIR=${join(dir, 'profile')}`)
    expect(env).toContain('HOME=/home/x')
    expect(env).not.toMatch(/ANTHROPIC_|AWS_|sk-leak/)
    expect(readFileSync(`${out}.args`, 'utf8')).toBe('mcp\nlist\n')
  })

  test('reports a launch failure instead of throwing', () => {
    const r = claudeRunner(join(dir, 'does-not-exist'), dir, {})(['mcp', 'list'])
    expect(r.status).not.toBe(0)
    expect(r.stderr).not.toBe('')
  })
})

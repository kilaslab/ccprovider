import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { orphanChecks, runDoctor, type Check, type Runtime } from '../src/doctor.js'
import { serverJson } from '../src/mcp.js'
import { findPreset } from '../src/presets.js'
import { profileDir, type Paths } from '../src/paths.js'
import { MemoryStore } from '../src/secrets/index.js'
import { installShim } from '../src/shim.js'
import type { Profile } from '../src/types.js'

const glm = findPreset('glm')!
const ZAI = glm.mcp!.regions[0]!
const allIds = glm.mcp!.servers.map((s) => s.id)

let home: string
let paths: Paths
let dir: string
let fake: string

const profile = (over: Partial<Profile> = {}): Profile => ({
  baseUrl: 'https://api.z.ai/api/anthropic',
  aliases: { opus: 'm', sonnet: 'm', haiku: 's', subagent: 's' },
  preset: 'glm',
  ...over,
})

const nodeOk: Runtime = { node: '24.16.0', npx: true }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-doc-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, 'providers.json'),
    dirsRoot: join(home, 'dirs'),
    cacheDir: join(home, 'cache'),
    binDir: join(home, 'bin'),
  }
  dir = profileDir(paths, 'glm')
  mkdirSync(dir, { recursive: true })
  fake = join(home, 'fake-ccprovider')
  writeFileSync(fake, '#!/bin/sh\n', { mode: 0o755 })
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

async function doctor(
  p: Profile,
  env: Record<string, string | undefined> = { PATH: paths.binDir },
  runtime = nodeOk,
  key?: string,
): Promise<Check[]> {
  const secrets = new MemoryStore()
  if (key !== undefined) await secrets.set('glm', key)
  return runDoctor('glm', p, paths, secrets, { skipNetwork: true, env, runtime })
}
const find = (checks: Check[], label: string) => checks.find((c) => c.label === label)

describe('command check', () => {
  const label = 'command `glm`'

  test('not installed is a warning that names the fix', async () => {
    const c = find(await doctor(profile()), label)!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('ccprovider install glm')
  })

  test('installed, resolvable and unshadowed is ok', async () => {
    installShim(paths, 'glm', [fake])
    expect(find(await doctor(profile()), label)!.status).toBe('ok')
  })

  test('a launcher whose program has gone is a failure — the command would just break', async () => {
    installShim(paths, 'glm', [fake])
    rmSync(fake)
    const c = find(await doctor(profile()), label)!
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('missing or not executable')
  })

  test('a bin directory off PATH is a warning that says so', async () => {
    installShim(paths, 'glm', [fake])
    const c = find(await doctor(profile(), { PATH: '/usr/bin' }), label)!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('not on PATH')
  })

  test('another program of the same name earlier on PATH is reported', async () => {
    installShim(paths, 'glm', [fake])
    const earlier = join(home, 'earlier')
    mkdirSync(earlier)
    writeFileSync(join(earlier, 'glm'), '#!/bin/sh\n', { mode: 0o755 })
    const c = find(await doctor(profile(), { PATH: `${earlier}:${paths.binDir}` }), label)!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain(join(earlier, 'glm'))
  })

  test('a file that is not ours occupying the name is reported, not overwritten', async () => {
    mkdirSync(paths.binDir, { recursive: true })
    writeFileSync(join(paths.binDir, 'glm'), '#!/bin/sh\necho other\n', { mode: 0o755 })
    const c = find(await doctor(profile()), label)!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('not a ccprovider launcher')
  })
})

describe('shared settings.json overrides', () => {
  const label = 'settings.json overrides'
  const writeSettings = (env: unknown) => writeFileSync(join(dir, 'settings.json'), JSON.stringify({ env, theme: 'dark' }))

  test('ANTHROPIC_* in the settings env is a failure: Claude Code applies it over the profile', async () => {
    // Measured on Claude Code 2.1.283: with the same variable in both places, the value
    // from settings.json is the one that reaches the network.
    writeSettings({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'sk-do-not-print' })
    const c = find(await doctor(profile()), label)!
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('ANTHROPIC_BASE_URL')
    expect(c.detail).toContain('ANTHROPIC_AUTH_TOKEN')
  })

  test('names the keys but never prints a value', async () => {
    writeSettings({ ANTHROPIC_AUTH_TOKEN: 'sk-do-not-print' })
    const c = find(await doctor(profile()), label)!
    expect(JSON.stringify(c)).not.toContain('sk-do-not-print')
  })

  test('reports the real file when settings.json is a link to the shared one', async () => {
    const shared = join(home, 'shared-settings.json')
    writeFileSync(shared, JSON.stringify({ env: { ANTHROPIC_MODEL: 'x' } }))
    symlinkSync(shared, join(dir, 'settings.json'))
    const c = find(await doctor(profile()), label)!
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('shared-settings.json')
  })

  test('tuning variables the profile owns are a warning, not a failure', async () => {
    // Regression: the first version only looked at ANTHROPIC_*, so a shared
    // CLAUDE_CODE_AUTO_COMPACT_WINDOW silently undid the profile's context-window setting
    // while doctor said everything was fine.
    writeSettings({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '200000' })
    const c = find(await doctor(profile()), label)!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW')
  })

  test.each(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_SUBAGENT_MODEL', 'ANTHROPIC_MODEL'])(
    '%s in the settings env is a failure',
    async (key) => {
      writeSettings({ [key]: 'x' })
      expect(find(await doctor(profile()), label)!.status).toBe('fail')
    },
  )

  test('an ANTHROPIC_* name ccprovider does not manage is left alone', async () => {
    writeSettings({ ANTHROPIC_LOG: 'debug' })
    expect(find(await doctor(profile()), label)!.status).toBe('ok')
  })

  test('unrelated env keys are fine', async () => {
    writeSettings({ FOO: '1', DISABLE_TELEMETRY: '1' })
    expect(find(await doctor(profile()), label)!.status).toBe('ok')
  })

  test('no settings file, no check', async () => {
    expect(find(await doctor(profile()), label)).toBeUndefined()
  })
})

describe('MCP checks', () => {
  const install = (ids: string[], region = ZAI) => {
    const servers = Object.fromEntries(ids.map((id) => [id, serverJson(glm.mcp!.servers.find((s) => s.id === id)!, region)]))
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: servers }))
  }
  const mcp = (checks: Check[]) => checks.filter((c) => c.label.startsWith('MCP'))

  test('a preset with MCP servers, never asked, is a warning that points at edit', async () => {
    const c = find(await doctor(profile()), 'MCP tools')!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('ccprovider edit glm')
  })

  test('opting out entirely is silent', async () => {
    expect(mcp(await doctor(profile({ mcp: [] })))).toEqual([])
  })

  test('presets without MCP servers are not asked about it', async () => {
    expect(mcp(await doctor(profile({ preset: 'deepseek', baseUrl: 'https://api.deepseek.com/anthropic' })))).toEqual([])
  })

  test('every enabled server that is registered as expected is ok', async () => {
    install(allIds)
    const checks = mcp(await doctor(profile({ mcp: allIds })))
    for (const id of allIds) expect(find(checks, `MCP ${id}`)!.status).toBe('ok')
  })

  test('an enabled server that is not registered is a warning', async () => {
    install(['zread'])
    const c = find(await doctor(profile({ mcp: ['zread', 'web-reader'] })), 'MCP web-reader')!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('not registered')
  })

  test('a registered server that has drifted is a warning', async () => {
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ mcpServers: { zread: { type: 'http', url: 'https://old.example/mcp' } } }))
    const c = find(await doctor(profile({ mcp: ['zread'] })), 'MCP zread')!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('differs')
  })

  test('an enabled ID the preset no longer defines is reported', async () => {
    const c = find(await doctor(profile({ mcp: ['retired'] })), 'MCP retired')!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('no longer defines')
  })

  test('an endpoint outside the known hosts installs nothing and says why', async () => {
    const c = find(await doctor(profile({ baseUrl: 'https://litellm.internal/anthropic', mcp: ['zread'] })), 'MCP tools')!
    expect(c.status).toBe('warn')
    expect(c.detail).toContain('https://api.z.ai')
  })

  test('a server still registered for a host the profile no longer uses is a failure — it would be sent the key', async () => {
    // Regression: the profile moved to a gateway, but zread stayed registered against api.z.ai
    // and its header helper keeps sending the profile's key there.
    install(['zread'])
    const gateway = profile({ baseUrl: 'https://litellm.internal/anthropic', mcp: ['zread'] })
    const c = find(await doctor(gateway), 'MCP zread')!
    expect(c.status).toBe('fail')
    expect(c.detail).toContain('would be sent this profile')
    expect(find(await doctor(gateway), 'MCP tools')).toBeUndefined() // the fail line is the report
  })

  test('the same is caught when the profile never enabled the server but it is registered', async () => {
    install(['zread', 'web-reader'])
    const checks = await doctor(profile({ baseUrl: 'https://litellm.internal/anthropic', mcp: [] }))
    expect(mcp(checks).map((c) => c.label).sort()).toEqual(['MCP web-reader', 'MCP zread'])
  })

  test('a gateway profile that never chose MCP gets no unanswerable "not chosen yet" nag', async () => {
    // Regression: edit cannot clear that warning on a gateway (the wizard has nothing to
    // offer there), so it was permanent.
    expect(mcp(await doctor(profile({ baseUrl: 'https://litellm.internal/anthropic' })))).toEqual([])
  })

  test('a key outside the header helper alphabet is called out for the web servers', async () => {
    const bad = find(await doctor(profile({ mcp: ['zread'] }), undefined, nodeOk, 'has space'), 'MCP key format')
    expect(bad!.status).toBe('warn')
    expect(find(await doctor(profile({ mcp: ['zread'] }), undefined, nodeOk, 'abc123.DEF456'), 'MCP key format')).toBeUndefined()
    // only the stdio server enabled: it takes the key from env, not the helper
    expect(find(await doctor(profile({ mcp: ['zai-mcp-server'] }), undefined, nodeOk, 'has space'), 'MCP key format')).toBeUndefined()
  })

  test('the mainland endpoint is recognised and checked against its own hosts', async () => {
    const zhipu = glm.mcp!.regions[1]!
    install(['zread'], zhipu)
    const c = find(await doctor(profile({ baseUrl: 'https://open.bigmodel.cn/api/anthropic', mcp: ['zread'] })), 'MCP zread')!
    expect(c.status).toBe('ok')
  })

  describe('the runtime the stdio server needs', () => {
    const label = 'MCP runtime (npx)'
    test('Node 22+ with npx is ok', async () => {
      expect(find(await doctor(profile({ mcp: allIds }), undefined, nodeOk), label)!.status).toBe('ok')
    })
    test('an older Node is a warning citing the requirement', async () => {
      const c = find(await doctor(profile({ mcp: allIds }), undefined, { node: '20.11.0', npx: true }), label)!
      expect(c.status).toBe('warn')
      expect(c.detail).toContain('Node 22')
    })
    test('no npx is a warning', async () => {
      expect(find(await doctor(profile({ mcp: allIds }), undefined, { node: '24.0.0', npx: false }), label)!.status).toBe('warn')
    })
    test('is not checked when only http servers are enabled', async () => {
      expect(find(await doctor(profile({ mcp: ['zread', 'web-reader'] })), label)).toBeUndefined()
    })
  })
})

describe('orphanChecks', () => {
  test('reports launchers whose profile is gone, and only those', () => {
    installShim(paths, 'glm', [fake])
    installShim(paths, 'old', [fake])
    mkdirSync(paths.binDir, { recursive: true })
    writeFileSync(join(paths.binDir, 'unrelated'), '#!/bin/sh\n', { mode: 0o755 })
    chmodSync(join(paths.binDir, 'unrelated'), 0o755)

    const found = orphanChecks(paths, ['glm'])
    expect(found).toHaveLength(1)
    expect(found[0]!.label).toBe('command `old`')
    expect(found[0]!.detail).toContain('ccprovider uninstall old')
  })

  test('none when every launcher has its profile', () => {
    installShim(paths, 'glm', [fake])
    expect(orphanChecks(paths, ['glm'])).toEqual([])
  })
})

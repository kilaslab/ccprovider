import { describe, expect, test } from 'bun:test'
import { buildEnv, resolveModel, missingSlots, redact, describeEnv, LaunchError, STRIPPED_VARS } from '../src/launch.js'
import { findPreset } from '../src/presets.js'
import type { Profile } from '../src/types.js'

const deepseek: Profile = {
  baseUrl: 'https://api.deepseek.com/anthropic',
  aliases: {
    opus: 'deepseek-v4-pro[1m]',
    sonnet: 'deepseek-v4-pro[1m]',
    haiku: 'deepseek-v4-flash',
    subagent: 'deepseek-v4-flash',
  },
  defaultModel: 'deepseek-v4-pro[1m]',
  autoCompactWindow: 786432,
  effortLevel: 'max',
}

const base = (extra: Record<string, string> = {}) => ({ PATH: '/usr/bin', HOME: '/home/u', ...extra })

const build = (profile: Profile, over: Partial<Parameters<typeof buildEnv>[0]> = {}) =>
  buildEnv({
    profile,
    configDir: '/cfg/deepseek',
    apiKey: 'sk-secret-token-value',
    baseEnv: base(),
    ...over,
  })

describe('alias slot mapping', () => {
  test('every slot the profile maps reaches its env var', () => {
    const env = build(deepseek)
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('deepseek-v4-flash')
  })

  test('subagent slot is set — an unmapped one 404s every Task spawn', () => {
    expect(build(deepseek).CLAUDE_CODE_SUBAGENT_MODEL).toBeDefined()
  })

  test('unmapped slots are left unset rather than filled with a wrong default', () => {
    const env = build(deepseek)
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBeUndefined()
  })

  test('missingSlots names exactly the slots that would fail', () => {
    expect(missingSlots(deepseek)).toEqual([])
    expect(missingSlots({ ...deepseek, aliases: { opus: 'x' } })).toEqual(['sonnet', 'haiku', 'subagent'])
  })
})

describe('[1m] suffix', () => {
  test('survives verbatim — Claude Code strips it, we must not', () => {
    const env = build(deepseek)
    expect(env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toContain('[1m]')
  })
})

describe('conflicting inherited vars', () => {
  test.each(STRIPPED_VARS.map((v) => [v]))('%s is removed from the child env', (name) => {
    const env = build(deepseek, { baseEnv: base({ [name]: 'inherited-value' }) })
    expect(env[name]).toBeUndefined()
  })

  test('an inherited ANTHROPIC_API_KEY cannot outrank the profile token', () => {
    const env = build(deepseek, { baseEnv: base({ ANTHROPIC_API_KEY: 'sk-ant-personal' }) })
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret-token-value')
  })

  test('blankApiKey re-adds it as empty, not as the inherited value', () => {
    const env = build({ ...deepseek, blankApiKey: true }, { baseEnv: base({ ANTHROPIC_API_KEY: 'sk-ant-personal' }) })
    expect(env.ANTHROPIC_API_KEY).toBe('')
  })

  test('a parent Claude Code session does not leak its identity into the child', () => {
    // Regression: launching from inside a session handed the new instance the
    // parent's session ID and messaging socket, so it attached instead of starting clean.
    const env = build(deepseek, {
      baseEnv: base({
        CLAUDE_CODE_SESSION_ID: '07d621aa-parent',
        CLAUDE_CODE_BRIDGE_SESSION_ID: 'session_parent',
        CLAUDE_CODE_CHILD_SESSION: '1',
        CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/45358.sock',
        CLAUDE_CODE_MESSAGING_TOKEN: 'deadbeef',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_EXECPATH: '/versions/2.1.241',
        CLAUDE_PID: '45358',
        CLAUDE_EFFORT: 'xhigh',
      }),
    })
    for (const k of [
      'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID', 'CLAUDE_EFFORT',
    ]) {
      expect(env[k]).toBeUndefined()
    }
    // the profile's own effort setting still wins
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
  })

  test('deliberate global CLAUDE_CODE_* settings are not swept up by the strip', () => {
    const env = build(deepseek, {
      baseEnv: base({ CLAUDE_CODE_ENABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }),
    })
    expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe('1')
  })

  test('unrelated env vars pass through untouched', () => {
    const env = build(deepseek, { baseEnv: base({ TERM: 'xterm-256color' }) })
    expect(env.TERM).toBe('xterm-256color')
    expect(env.PATH).toBe('/usr/bin')
  })
})

describe('model selection', () => {
  test('defaults to defaultModel', () => {
    expect(build(deepseek).ANTHROPIC_MODEL).toBe('deepseek-v4-pro[1m]')
  })

  test('-m with a tier name resolves through the aliases', () => {
    expect(build(deepseek, { model: 'haiku' }).ANTHROPIC_MODEL).toBe('deepseek-v4-flash')
  })

  test('-m with a raw provider model ID passes through', () => {
    expect(build(deepseek, { model: 'deepseek-v3.2' }).ANTHROPIC_MODEL).toBe('deepseek-v3.2')
  })

  test('falls back to the opus alias when no default is set', () => {
    const { defaultModel, ...noDefault } = deepseek
    expect(resolveModel(noDefault as Profile)).toBe('deepseek-v4-pro[1m]')
  })

  test('an unmapped tier is a clear error, not a silent Claude model ID', () => {
    expect(() => resolveModel({ ...deepseek, aliases: { opus: 'x' } }, 'haiku')).toThrow(LaunchError)
  })
})

describe('window and output settings', () => {
  test('autoCompactWindow and effortLevel are forwarded', () => {
    const env = build(deepseek)
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('786432')
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('max')
  })

  test('null settings are omitted rather than sent as "null"', () => {
    const env = build({ ...deepseek, autoCompactWindow: null, maxOutputTokens: null, effortLevel: null })
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined()
    expect(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBeUndefined()
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBeUndefined()
  })

  test('maxOutputTokens of 0 is still forwarded (not swallowed as falsy)', () => {
    expect(build({ ...deepseek, maxOutputTokens: 0 }).CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('0')
  })
})

describe('secret handling', () => {
  test('redact keeps only the ends', () => {
    expect(redact('sk-secret-token-value')).toBe('sk-s…alue')
    expect(redact('short')).toBe('****')
  })

  test('describeEnv never emits the raw token', () => {
    const shown = describeEnv(build(deepseek))
    expect(JSON.stringify(shown)).not.toContain('sk-secret-token-value')
    expect(shown.ANTHROPIC_AUTH_TOKEN).toBe('sk-s…alue')
  })
})

describe('purity', () => {
  test('does not mutate the caller-supplied baseEnv', () => {
    const baseEnv = base({ ANTHROPIC_API_KEY: 'sk-ant-personal' })
    build(deepseek, { baseEnv })
    expect(baseEnv.ANTHROPIC_API_KEY).toBe('sk-ant-personal')
  })
})

describe('every shipped preset produces a working environment', () => {
  const withAliases = ['deepseek', 'kimi', 'glm', 'minimax']
  test.each(withAliases.map((id) => [id]))('%s fills all required slots', (id) => {
    const preset = findPreset(id)!
    const profile: Profile = {
      baseUrl: preset.baseUrl,
      aliases: preset.aliases ?? {},
      defaultModel: preset.defaultModel ?? null,
      autoCompactWindow: preset.autoCompactWindow ?? null,
    }
    expect(missingSlots(profile)).toEqual([])
    const env = build(profile)
    expect(env.ANTHROPIC_BASE_URL).toStartWith('https://')
    expect(env.ANTHROPIC_MODEL).toBeTruthy()
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBeTruthy()
  })
})

import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { dotenvWarnings, ENV_FORMATS, formatEnv, parseEnvFormat } from '../src/envformat.js'
import { CREDENTIAL_VARS } from '../src/launch.js'

const env = {
  CLAUDE_CONFIG_DIR: '/home/me/.local/share/ccprovider/dirs/glm',
  ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'sk-a$b"c',
  ANTHROPIC_MODEL: 'glm-5.3[1m]',
}

describe('formatEnv sh', () => {
  test('is the original `export` listing, config dir included', () => {
    const out = formatEnv(env, 'sh')
    expect(out).toContain("export CLAUDE_CONFIG_DIR='/home/me/.local/share/ccprovider/dirs/glm'\n")
    expect(out).toContain("export ANTHROPIC_BASE_URL='https://api.z.ai/api/anthropic'\n")
  })

  // The same leak the other formats close: a real Anthropic key left in the shell is sent to
  // the provider next to the token, and `eval "$(ccprovider env x)"` is how this format is used.
  // What `use` does to an inherited key is delete it, so the shell form unsets it, which is the
  // same thing. Only a file or an object, which cannot unset, has to blank it.
  test('unsets ANTHROPIC_API_KEY, as `use` does, so eval does not leave an Anthropic key in reach', () => {
    expect(formatEnv(env, 'sh')).toContain('unset ANTHROPIC_API_KEY\n')
    expect(formatEnv(env, 'sh')).not.toContain('export ANTHROPIC_API_KEY')
    const script = "ANTHROPIC_API_KEY=sk-ant-stray; export ANTHROPIC_API_KEY\n" + formatEnv(env, 'sh') + 'printf %s "[$ANTHROPIC_API_KEY]"'
    expect(execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' })).toBe('[]')
  })

  test('keeps the blank value a profile asks for, rather than unsetting it', () => {
    const out = formatEnv({ ...env, ANTHROPIC_API_KEY: '' }, 'sh')
    expect(out).toContain("export ANTHROPIC_API_KEY=''\n")
    expect(out).not.toContain('unset ANTHROPIC_API_KEY')
  })

  test('round-trips through a real shell', () => {
    const script = formatEnv(env, 'sh') + 'printf %s "$ANTHROPIC_AUTH_TOKEN"'
    expect(execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' })).toBe('sk-a$b"c')
  })
})

describe('formatEnv dotenv', () => {
  test('is KEY=value with the value raw — docker --env-file does no unquoting', () => {
    const out = formatEnv(env, 'dotenv')
    expect(out).toContain('ANTHROPIC_AUTH_TOKEN=sk-a$b"c\n')
    expect(out).toContain('ANTHROPIC_MODEL=glm-5.3[1m]\n')
    expect(out).not.toContain('export')
    expect(out).not.toContain("'")
  })

  // The host's profile dir means nothing inside a container, and an SDK that is handed
  // it would point Claude Code at a path that does not exist there.
  test('leaves out CLAUDE_CONFIG_DIR', () => {
    expect(formatEnv(env, 'dotenv')).not.toContain('CLAUDE_CONFIG_DIR')
  })

  // Regression: measured against a fake provider, Claude Code sends BOTH `Authorization:
  // Bearer <token>` and `x-api-key: <ANTHROPIC_API_KEY>` to ANTHROPIC_BASE_URL when both are
  // set, so an Anthropic key left in the shell reaches the provider. An empty value sends
  // no header. A file can only set variables, never remove them, hence an empty one.
  test('blanks ANTHROPIC_API_KEY, so an inherited Anthropic key is not sent to the provider', () => {
    expect(formatEnv(env, 'dotenv')).toContain('ANTHROPIC_API_KEY=\n')
  })

  test('does not repeat ANTHROPIC_API_KEY when the profile already blanks it', () => {
    const out = formatEnv({ ...env, ANTHROPIC_API_KEY: '' }, 'dotenv')
    expect(out.match(/ANTHROPIC_API_KEY=/g)).toHaveLength(1)
  })

  test('refuses a value with a line break, which would split into a second variable', () => {
    expect(() => formatEnv({ ANTHROPIC_AUTH_TOKEN: 'a\nANTHROPIC_BASE_URL=https://evil.example' }, 'dotenv')).toThrow(/line break/)
    expect(() => formatEnv({ ANTHROPIC_AUTH_TOKEN: 'a\rb' }, 'dotenv')).toThrow(/line break/)
  })
})

describe('formatEnv json', () => {
  test('is one flat object an SDK can take as `env`', () => {
    const parsed = JSON.parse(formatEnv(env, 'json'))
    expect(parsed).toMatchObject({
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'sk-a$b"c',
      ANTHROPIC_MODEL: 'glm-5.3[1m]',
    })
    // Nothing else of the profile's, beyond the credentials it blanks (see below).
    expect(Object.keys(parsed).filter((k) => parsed[k] !== '').sort()).toEqual(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL'])
  })

  test('leaves out CLAUDE_CONFIG_DIR', () => {
    expect(formatEnv(env, 'json')).not.toContain('CLAUDE_CONFIG_DIR')
  })

  test('blanks ANTHROPIC_API_KEY, so spreading it over process.env cannot leak an Anthropic key', () => {
    const merged = { ...{ ANTHROPIC_API_KEY: 'sk-ant-stray' }, ...JSON.parse(formatEnv(env, 'json')) }
    expect(merged.ANTHROPIC_API_KEY).toBe('')
  })

  test('takes a value with a line break, since JSON escapes it', () => {
    expect(JSON.parse(formatEnv({ K: 'a\nb' }, 'json')).K).toBe('a\nb')
  })
})

describe('parseEnvFormat', () => {
  test('defaults to sh, so existing `eval "$(ccprovider env x)"` keeps working', () => {
    expect(parseEnvFormat(undefined)).toBe('sh')
  })

  test.each([...ENV_FORMATS])('accepts %s', (f) => {
    expect(parseEnvFormat(f)).toBe(f)
  })

  test('names the choices when given something else', () => {
    expect(() => parseEnvFormat('yaml')).toThrow(/sh, dotenv, json/)
  })
})

describe('dotenvWarnings', () => {
  // `docker run --env-file` reads a value as it is. Compose's env_file and python-dotenv trim
  // it, strip matching quotes, expand `$` and treat ` #` as a comment.
  test('names the variables whose value another dotenv parser would change', () => {
    expect(
      dotenvWarnings({
        A_PLAIN: 'sk-abc.DEF_123',
        B_SPACE: ' padded',
        C_TRAIL: 'padded ',
        D_QUOTE: '"quoted"',
        E_COMMENT: 'value #note',
        F_DOLLAR: 'a$b',
        G_BRACKETS: 'glm-5.3[1m]',
        CLAUDE_CONFIG_DIR: '/p ath #x',
      }),
    ).toEqual(['B_SPACE', 'C_TRAIL', 'D_QUOTE', 'E_COMMENT', 'F_DOLLAR'])
  })

  test('says nothing for an ordinary profile', () => {
    expect(dotenvWarnings({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: 'abc123.def-456', ANTHROPIC_MODEL: 'glm-5.3[1m]' })).toEqual([])
  })
})

describe('credentials and routing a launch would drop', () => {
  // Measured against a fake provider: with these left in the environment, an Anthropic
  // x-api-key and a custom header both reached the provider, and CLAUDE_CODE_USE_BEDROCK stopped
  // any request from reaching it at all. Emptied, none of that happened and routing was normal.
  test('the list is the credentials and routing flags `use` strips, and nothing else', () => {
    expect([...CREDENTIAL_VARS].sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_BEDROCK_BASE_URL',
      'ANTHROPIC_CUSTOM_HEADERS',
      'ANTHROPIC_VERTEX_BASE_URL',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_USE_VERTEX',
    ])
  })

  test('are unset by the shell form', () => {
    const out = formatEnv(env, 'sh')
    for (const v of CREDENTIAL_VARS) expect(out).toContain(`unset ${v}\n`)
    const script = [...CREDENTIAL_VARS].map((v) => `${v}=stray; export ${v}`).join('\n') + '\n' + out + 'env'
    const printed = execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' })
    for (const v of CREDENTIAL_VARS) expect(printed).not.toMatch(new RegExp(`^${v}=`, 'm'))
  })

  test('are carried empty by the file and object forms, which cannot unset', () => {
    const json = JSON.parse(formatEnv(env, 'json'))
    const dotenv = formatEnv(env, 'dotenv')
    for (const v of CREDENTIAL_VARS) {
      expect(json[v]).toBe('')
      expect(dotenv).toContain(`${v}=\n`)
    }
  })

  test('leave alone one the profile sets itself', () => {
    const out = formatEnv({ ...env, ANTHROPIC_API_KEY: '' }, 'sh')
    expect(out).toContain("export ANTHROPIC_API_KEY=''\n")
    expect(out).not.toContain('unset ANTHROPIC_API_KEY')
    expect(formatEnv({ ...env, ANTHROPIC_API_KEY: '' }, 'dotenv').match(/ANTHROPIC_API_KEY=/g)).toHaveLength(1)
  })

  test('are unset for a subscription profile too, whose login they would compete with', () => {
    const out = formatEnv({ CLAUDE_CONFIG_DIR: '/p' }, 'sh')
    for (const v of CREDENTIAL_VARS) expect(out).toContain(`unset ${v}\n`)
  })
})

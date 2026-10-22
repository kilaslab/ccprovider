// The prompts are scripted, so this file mocks the prompts module for the whole test process:
// keep wizard tests here and nowhere else.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveSettings } from '../src/settings.js'
import type { Paths } from '../src/paths.js'
import type { Profile } from '../src/types.js'

interface Asked {
  kind: string
  message: string
  options?: any
}
const script: unknown[] = []
const asked: Asked[] = []

const ask = (kind: string) => async (options: any) => {
  asked.push({ kind, message: String(options?.message ?? ''), options })
  if (!script.length) throw new Error(`unscripted ${kind}: ${options?.message}`)
  const answer = script.shift()
  if (answer instanceof Error) throw answer
  return answer
}
const fakeP = {
  text: ask('text'), select: ask('select'), multiselect: ask('multiselect'), confirm: ask('confirm'),
  password: ask('password'), autocomplete: ask('autocomplete'),
  log: { info() {}, warn() {}, error() {}, message() {}, success() {} },
  spinner: () => ({ start() {}, stop() {}, message() {} }),
  intro() {}, outro() {}, cancel() {}, note() {}, isCancel: () => false,
}
mock.module('../src/tui/prompts.js', () => ({ p: fakeP, orCancel: (v: unknown) => v }))
const { runWizard } = await import('../src/tui/wizard.js')

let home: string
let paths: Paths
beforeEach(() => {
  script.length = 0
  asked.length = 0
  home = mkdtempSync(join(tmpdir(), 'ccprov-wizard-'))
  paths = {
    claudeDir: join(home, '.claude'),
    configFile: join(home, 'config', 'providers.json'),
    settingsFile: join(home, 'config', 'settings.json'),
    dirsRoot: join(home, 'dirs'),
    cacheDir: join(home, 'cache'),
    binDir: join(home, 'bin'),
    defaultBinDir: join(home, 'default-bin'),
    usageDir: join(home, 'usage'),
  }
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const token: Profile = { kind: 'claude-token', baseUrl: '', aliases: {}, preset: 'claude-token' }
const login: Profile = { kind: 'oauth', baseUrl: '', aliases: {}, preset: 'claude' }
const messages = () => asked.map((a) => a.message)
const shareQuestion = () => asked.find((a) => a.message.startsWith('Share chat sessions'))!

describe('add --default, the setup-token path', () => {
  // provider, token, share?, agents, Explore, confirm
  const answers = (share: boolean) => ['claude-token', 'sk-ant-oat01-x', share, [], 'default', true]

  test('names the profile itself, asks nothing about a name, and says what it replaces', async () => {
    script.push(...answers(false))
    const r = await runWizard(paths, null, ['default', 'glm'], false, { slot: true, current: token })
    if ('editInstead' in r) throw new Error('unexpected')
    expect(r.name).toBe('default')
    expect(r.replace).toBe(false)
    expect(r.profile.kind).toBe('claude-token')
    expect(r.apiKey).toBe('sk-ant-oat01-x')
    expect(messages().some((m) => m.startsWith('Profile name'))).toBe(false)
    expect(messages().at(-1)).toContain('replacing the existing profile named "default"')
  })

  test('a sharing question for a profile that does not share has agents and Explore after it', async () => {
    script.push(...answers(false))
    await runWizard(paths, null, [], false, { slot: true })
    expect(messages().findIndex((m) => m.startsWith('Share chat sessions'))).toBeLessThan(messages().findIndex((m) => m.startsWith('Agents')))
  })

  test('sharing starts from the slot\'s own answer, not the global default', async () => {
    script.push(...answers(true))
    await runWizard(paths, null, ['default'], false, { slot: true, current: { ...token, shareSessions: true } })
    expect(shareQuestion().options.initialValue).toBe(true) // the global default is off
  })

  test('a /login occupant has no answer to start from, so the global default decides', async () => {
    saveSettings(paths, { version: 1, shareSessions: true })
    script.push(...answers(true))
    await runWizard(paths, null, ['default'], false, { slot: true, current: login })
    // A /login never shares; starting from its "No" would pin that onto the new profile.
    expect(shareQuestion().options.initialValue).toBe(true)
  })

  test('a sharing profile is not asked for agents or an Explore model', async () => {
    script.push('claude-token', 'sk-ant-oat01-x', true, true) // provider, token, share, confirm
    const r = await runWizard(paths, null, [], false, { slot: true })
    if ('editInstead' in r) throw new Error('unexpected')
    expect(r.agents).toEqual([])
    expect(r.explore).toBeNull()
    expect(messages().some((m) => m.startsWith('Agents'))).toBe(false)
  })
})

describe('add --default, the /login path', () => {
  test('confirms before replacing the default, like every other provider', async () => {
    script.push('claude', [], 'default', true) // provider, agents, Explore, confirm
    const r = await runWizard(paths, null, ['default'], false, { slot: true })
    if ('editInstead' in r) throw new Error('unexpected')
    expect(r.name).toBe('default')
    expect(r.profile.kind).toBe('oauth')
    expect(r.apiKey).toBeNull()
    expect(asked.at(-1)!.kind).toBe('confirm')
    expect(asked.at(-1)!.message).toContain('replacing the existing profile named "default"')
  })
})

describe('naming a new profile', () => {
  test('the reserved name is refused where it is typed', async () => {
    script.push('claude', new Error('stop here'))
    await expect(runWizard(paths, null, [], false)).rejects.toThrow('stop here')
    const name = asked.find((a) => a.message === 'Profile name')!
    expect(name.options.validate('default')).toContain('reserved')
    expect(name.options.validate('work')).toBeUndefined()
  })

  test('add offers the setup-token provider; editing a profile with no preset does not', async () => {
    script.push(new Error('stop here'))
    await expect(runWizard(paths, null, [], false)).rejects.toThrow('stop here')
    expect(asked[0]!.options.options.map((o: { value: string }) => o.value)).toContain('claude-token')

    asked.length = 0
    script.push(new Error('stop here'))
    const existing = { name: 'mine', profile: { baseUrl: 'https://x.test', aliases: {} } as Profile, apiKey: 'k' }
    await expect(runWizard(paths, existing, [], false)).rejects.toThrow('stop here')
    // Turning a provider key into a Claude token would send that key to Anthropic.
    expect(asked[0]!.options.options.map((o: { value: string }) => o.value)).not.toContain('claude-token')
  })
})

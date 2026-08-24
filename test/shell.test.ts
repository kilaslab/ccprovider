import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { shellQuote } from '../src/shell.js'

/** Round-trip through a real shell: whatever goes in must come out byte-identical
 *  and nothing may execute. */
function throughShell(value: string): string {
  return execFileSync('/bin/sh', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' })
}

describe('shellQuote', () => {
  // Regression: `env` used JSON.stringify, whose double quotes still expand $(…).
  // The command is documented as `eval "$(ccprovider env <name>)"`, and model IDs
  // come from the provider's own model-list endpoint — so they are not trusted input.
  test.each([
    ['plain', 'deepseek-v4-pro'],
    ['suffix', 'deepseek-v4-pro[1m]'],
    ['command substitution', 'm-$(touch /tmp/ccprovider-pwned)'],
    ['backticks', 'm-`touch /tmp/ccprovider-pwned`'],
    ['variable', 'm-$HOME'],
    ['single quote', "m-'quoted'"],
    ['double quote', 'm-"quoted"'],
    ['semicolon', 'm; rm -rf /'],
    ['newline', 'a\nb'],
    ['backslash', 'a\\b'],
  ])('%s survives a real shell verbatim', (_label, value) => {
    expect(throughShell(value)).toBe(value)
  })

  test('command substitution does not execute', () => {
    const marker = '/tmp/ccprovider-pwned-test'
    execFileSync('/bin/sh', ['-c', `rm -f ${marker}`])
    throughShell(`m-$(touch ${marker})`)
    expect(() => execFileSync('/bin/sh', ['-c', `test -e ${marker}`])).toThrow()
  })

  test('an API key containing $ is not corrupted', () => {
    expect(throughShell('sk-a$b$c')).toBe('sk-a$b$c')
  })
})

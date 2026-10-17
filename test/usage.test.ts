import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ProfileError } from '../src/profile.js'
import type { Paths } from '../src/paths.js'
import {
  aggregate,
  emptyLedger,
  ledgerFiles,
  loadLedger,
  parseSince,
  prepareLedger,
  progressPercent,
  renderUsage,
  saveLedger,
  scanProfile,
  unreadableTotal,
  type Ledger,
} from '../src/usage.js'

let dir: string // a profile directory
let projects: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccprov-usage-'))
  projects = join(dir, 'projects')
  mkdirSync(join(projects, '-work-app'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const T0 = Date.UTC(2026, 9, 10, 12, 0, 0) / 1000 // 2026-10-10 12:00 UTC
const DAY = 86400

interface U {
  input?: number
  output?: number
  cacheRead?: number | null
  cacheWrite?: number | null
}

/** One transcript line, in the shape Claude Code writes it. Cache fields are left out when
 *  null, as some providers do. */
function assistant(id: string, model: string, u: U, at = T0): string {
  const usage: Record<string, unknown> = { input_tokens: u.input ?? 0, output_tokens: u.output ?? 0 }
  if (u.cacheRead !== null && u.cacheRead !== undefined) usage.cache_read_input_tokens = u.cacheRead
  if (u.cacheWrite !== null && u.cacheWrite !== undefined) usage.cache_creation_input_tokens = u.cacheWrite
  return JSON.stringify({
    parentUuid: 'p',
    isSidechain: false,
    type: 'assistant',
    message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'a private reply' }], usage },
    timestamp: new Date(at * 1000).toISOString(),
  })
}

const write = (rel: string, lines: string[], tail = '\n') => {
  const path = join(projects, rel)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.join('\n') + tail)
  return path
}

const scan = async (ledger: Ledger = emptyLedger()) => ({ ledger, result: await scanProfile(dir, ledger) })
const calls = (l: Ledger) => Object.keys(l.calls).length

describe('one API call is written as several lines', () => {
  // Measured on a real GLM transcript: 2,700 assistant lines were 1,250 message ids, and the
  // early snapshots of a call read 0 input and 0 output.
  test('counts it once, with the numbers of its last snapshot', async () => {
    write('-work-app/s1.jsonl', [
      assistant('msg_1', 'glm-5.3', { input: 0, output: 0 }),
      assistant('msg_1', 'glm-5.3', { input: 0, output: 0 }),
      assistant('msg_1', 'glm-5.3', { input: 26250, output: 232, cacheRead: 832 }),
      assistant('msg_1', 'glm-5.3', { input: 26250, output: 232, cacheRead: 832 }),
    ])
    const { ledger } = await scan()
    expect(calls(ledger)).toBe(1)
    expect(ledger.calls.msg_1).toEqual(['glm-5.3', T0, 26250, 232, 832, null])
  })

  // Measured on Anthropic's: output_tokens grows from one snapshot to the next, so keeping the
  // first line (the usual shortcut) undercounts what the model wrote.
  test('takes the largest output when the snapshots grow', async () => {
    write('-work-app/s1.jsonl', [
      assistant('msg_1', 'claude-opus-5-5', { input: 2, output: 10, cacheRead: 100, cacheWrite: 5 }),
      assistant('msg_1', 'claude-opus-5-5', { input: 2, output: 246, cacheRead: 100, cacheWrite: 5 }),
      assistant('msg_1', 'claude-opus-5-5', { input: 2, output: 120, cacheRead: 100, cacheWrite: 5 }),
    ])
    const { ledger } = await scan()
    expect(ledger.calls.msg_1![3]).toBe(246)
  })

  test('counts a call that a resumed session copied into a second file once', async () => {
    write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 100, output: 5 })])
    write('-work-app/s2.jsonl', [assistant('msg_1', 'glm-5.3', { input: 100, output: 5 }), assistant('msg_2', 'glm-5.3', { input: 7, output: 1 })])
    const { ledger } = await scan()
    expect(calls(ledger)).toBe(2)
  })
})

describe('what is counted', () => {
  // Measured: subagents were 44,153 of the 51,137 calls in one profile.
  test('includes subagent transcripts, which sit deeper in the tree', async () => {
    write('-work-app/s1.jsonl', [assistant('msg_main', 'glm-5.3', { input: 1, output: 1 })])
    write('-work-app/s1/subagents/agent-a1.jsonl', [assistant('msg_sub', 'glm-5.3-flash', { input: 2, output: 2 })])
    const { ledger } = await scan()
    expect(Object.keys(ledger.calls).sort()).toEqual(['msg_main', 'msg_sub'])
  })

  test('skips synthetic messages, other line types, and assistant lines with no usage', async () => {
    write('-work-app/s1.jsonl', [
      assistant('msg_syn', '<synthetic>', { input: 0, output: 0 }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'cost-state', totalCostUSD: 5 }),
      JSON.stringify({ type: 'assistant', message: { id: 'msg_nousage', model: 'glm-5.3', content: [] } }),
      assistant('msg_ok', 'glm-5.3', { input: 3, output: 4 }),
    ])
    const { ledger } = await scan()
    expect(Object.keys(ledger.calls)).toEqual(['msg_ok'])
  })

  // Claude Code writes compact JSON, but nothing in the format promises it, and a prefilter
  // that looked for `"type":"assistant"` byte for byte would silently count nothing.
  test('reads a line however its JSON is spaced', async () => {
    const spaced = assistant('msg_1', 'glm-5.3', { input: 3, output: 4 }).replace(/":/g, '": ').replace(/,"/g, ', "')
    expect(spaced).toContain('"type": "assistant"')
    write('-work-app/s1.jsonl', [spaced])
    const { ledger } = await scan()
    expect(ledger.calls.msg_1).toEqual(['glm-5.3', T0, 3, 4, null, null])
  })

  test('only reads .jsonl files', async () => {
    write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })])
    write('-work-app/notes.txt', [assistant('msg_2', 'glm-5.3', { input: 1, output: 1 })])
    const { ledger } = await scan()
    expect(Object.keys(ledger.calls)).toEqual(['msg_1'])
  })

  test('a profile that has never run has nothing to read', async () => {
    rmSync(projects, { recursive: true })
    const { ledger, result } = await scan()
    expect(calls(ledger)).toBe(0)
    expect(result.filesRead).toBe(0)
  })
})

describe('cache that a provider does not report', () => {
  test('is kept as null, not 0', async () => {
    write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 10, output: 2 })])
    const { ledger } = await scan()
    expect(ledger.calls.msg_1).toEqual(['glm-5.3', T0, 10, 2, null, null])
  })

  test('a later snapshot that does report it wins over one that did not', async () => {
    write('-work-app/s1.jsonl', [
      assistant('msg_1', 'glm-5.3', { input: 0, output: 0 }),
      assistant('msg_1', 'glm-5.3', { input: 10, output: 2, cacheRead: 40, cacheWrite: 0 }),
    ])
    const { ledger } = await scan()
    expect(ledger.calls.msg_1).toEqual(['glm-5.3', T0, 10, 2, 40, 0])
  })
})

describe('reading a file that is still being written', () => {
  test('skips a line that does not parse and says how many', async () => {
    write('-work-app/s1.jsonl', ['{"type":"assistant","message":{"id":"msg_bad","usage":{"input_tok', assistant('msg_ok', 'glm-5.3', { input: 1, output: 1 })])
    const { ledger, result } = await scan()
    expect(Object.keys(ledger.calls)).toEqual(['msg_ok'])
    expect(result.unreadableLines).toBe(1)
  })

  // Whatever a provider calls its calls: the ids come from the file and are only ever keys.
  test('counts a call however its id is spelled, and keeps `__proto__` an ordinary key', async () => {
    write('-work-app/s1.jsonl', [
      assistant('gen/abc+123@x', 'glm-5.3', { input: 1, output: 1 }),
      assistant('__proto__', 'glm-5.3', { input: 2, output: 2 }),
      assistant('msg_ok', 'glm-5.3', { input: 1, output: 1 }),
    ])
    const { ledger, result } = await scan()
    expect(Object.keys(ledger.calls).sort()).toEqual(['__proto__', 'gen/abc+123@x', 'msg_ok'])
    expect(result.unreadableLines).toBe(0)
    expect(Object.getPrototypeOf(ledger.calls)).toBe(Object.prototype)
    expect(Object.hasOwn(ledger.calls, '__proto__')).toBe(true)
    expect(aggregate({ glm: ledger }, {})[0]!.calls).toBe(3)
  })

  test('a call filed as `__proto__` survives being saved and loaded', async () => {
    write('-work-app/s1.jsonl', [assistant('__proto__', 'glm-5.3', { input: 2, output: 2 })])
    const { ledger } = await scan()
    const path = join(dir, 'usage', 'glm.json')
    saveLedger(path, ledger)
    const back = loadLedger(path)!
    expect(Object.hasOwn(back.calls, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(back.calls)).toBe(Object.prototype)
  })

  test('an id too long to be a real one is reported, not filed', async () => {
    write('-work-app/s1.jsonl', [assistant('x'.repeat(600), 'glm-5.3', { input: 1, output: 1 }), assistant('msg_ok', 'glm-5.3', { input: 1, output: 1 })])
    const { ledger, result } = await scan()
    expect(Object.keys(ledger.calls)).toEqual(['msg_ok'])
    expect(result.unreadableLines).toBe(1)
  })

  // The writer may be half way through a line. Reading it would drop the call, or count
  // 0 tokens for it, and the offset would then move past it for good.
  test('does not consume a last line that has no newline yet, and picks it up once it does', async () => {
    const path = write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })], '\n')
    appendFileSync(path, assistant('msg_2', 'glm-5.3', { input: 9, output: 9 }).slice(0, 60)) // cut off
    const first = await scan()
    expect(Object.keys(first.ledger.calls)).toEqual(['msg_1'])
    expect(first.result.unreadableLines).toBe(0)

    // The rest of the line arrives, then the newline.
    writeFileSync(path, [assistant('msg_1', 'glm-5.3', { input: 1, output: 1 }), assistant('msg_2', 'glm-5.3', { input: 9, output: 9 })].join('\n') + '\n')
    await scanProfile(dir, first.ledger)
    expect(Object.keys(first.ledger.calls).sort()).toEqual(['msg_1', 'msg_2'])
  })
})

describe('reading again', () => {
  test('a second pass over unchanged files reads nothing and changes nothing', async () => {
    write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })])
    const first = await scan()
    const before = structuredClone(first.ledger)
    const again = await scanProfile(dir, first.ledger)
    expect(again.bytesRead).toBe(0)
    expect(first.ledger).toEqual(before)
  })

  test('reads only what was appended', async () => {
    const path = write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })])
    const { ledger } = await scan()
    const added = assistant('msg_2', 'glm-5.3', { input: 5, output: 5 }) + '\n'
    appendFileSync(path, added)
    const again = await scanProfile(dir, ledger)
    expect(again.bytesRead).toBe(Buffer.byteLength(added))
    expect(calls(ledger)).toBe(2)
  })

  // The rewritten file holds a call the ledger has never seen, so skipping it (because its
  // size is below the old offset) would lose that call, and the test says so.
  test('a file that shrank is read again from the start', async () => {
    const path = write('-work-app/s1.jsonl', [
      assistant('msg_1', 'glm-5.3', { input: 100, output: 10 }),
      assistant('msg_2', 'glm-5.3', { input: 100, output: 10 }),
    ])
    const { ledger } = await scan()
    writeFileSync(path, assistant('msg_3', 'glm-5.3', { input: 50, output: 5 }) + '\n') // rewritten, shorter
    await scanProfile(dir, ledger)
    expect(aggregate({ glm: ledger }, {}).map((r) => [r.calls, r.input])).toEqual([[3, 250]])
  })

  // Regression guard for the merge rule: reading a call again must not add it twice.
  test('reading a file again from the start counts nothing twice', async () => {
    write('-work-app/s1.jsonl', [
      assistant('msg_1', 'glm-5.3', { input: 100, output: 10 }),
      assistant('msg_2', 'glm-5.3', { input: 100, output: 10 }),
    ])
    const { ledger } = await scan()
    ledger.files['-work-app/s1.jsonl'] = { offset: 0 } // as if its offset had been lost
    await scanProfile(dir, ledger)
    expect(aggregate({ glm: ledger }, {}).map((r) => [r.calls, r.input, r.output])).toEqual([[2, 200, 20]])
  })

  test('a transcript Claude Code later deletes still counts', async () => {
    const path = write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 100, output: 10 })])
    const { ledger } = await scan()
    rmSync(path)
    await scanProfile(dir, ledger)
    expect(calls(ledger)).toBe(1)
  })

  test('a fresh ledger sees only what is on disk, which is what a rebuild does', async () => {
    const path = write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 100, output: 10 })])
    await scan()
    rmSync(path)
    const { ledger } = await scan(emptyLedger())
    expect(calls(ledger)).toBe(0)
  })
})

describe('an id that is also a name every object has', () => {
  // The transcript is not ours. `constructor` passes for an id, and looking it up on a plain
  // object finds Object itself, which is then "updated": numbers written onto a global.
  test('is a call like any other, and nothing global is touched', async () => {
    const before = Object.getOwnPropertyNames(Object).sort()
    write('-work-app/s1.jsonl', [
      assistant('constructor', 'glm-5.3', { input: 5, output: 1 }),
      assistant('constructor', 'glm-5.3', { input: 5, output: 9 }),
      assistant('toString', 'glm-5.3', { input: 3, output: 1 }),
      assistant('hasOwnProperty', 'glm-5.3', { input: 2, output: 1 }),
      assistant('valueOf', 'glm-5.3', { input: 1, output: 1 }),
    ])
    const { ledger } = await scan()
    expect(Object.getOwnPropertyNames(Object).sort()).toEqual(before)
    expect(Object.keys(ledger.calls).sort()).toEqual(['constructor', 'hasOwnProperty', 'toString', 'valueOf'])
    expect((ledger.calls as Record<string, unknown>)['constructor']).toEqual(['glm-5.3', T0, 5, 9, null, null])
  })
})

describe('lines that could not be read', () => {
  const bad = '{"type":"assistant","message":{"id":"msg_bad","usage":{"input_tok'

  // Skipped lines are calls missing from the totals for good. A pass that reads nothing new
  // must not report "0" as if they had never been there.
  test('are still reported by the passes after the one that met them', async () => {
    write('-work-app/s1.jsonl', [bad, assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })])
    const first = await scan()
    expect(first.result.unreadableLines).toBe(1)
    const again = await scanProfile(dir, first.ledger)
    expect(again.unreadableLines).toBe(0)
    expect(unreadableTotal(first.ledger)).toBe(1)
  })

  test('are not counted twice when a file is read from the start again', async () => {
    const path = write('-work-app/s1.jsonl', [bad, assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })])
    const { ledger } = await scan()
    ledger.files['-work-app/s1.jsonl'] = { offset: 0 }
    await scanProfile(dir, ledger)
    expect(unreadableTotal(ledger)).toBe(1)
    expect(path).toBeTruthy()
  })

  test('add up across files, and across later appends', async () => {
    const a = write('-work-app/a.jsonl', [bad])
    write('-work-app/b.jsonl', [bad, bad])
    const { ledger } = await scan()
    expect(unreadableTotal(ledger)).toBe(3)
    appendFileSync(a, bad + '\n')
    await scanProfile(dir, ledger)
    expect(unreadableTotal(ledger)).toBe(4)
  })
})

describe('a transcript that was rewritten', () => {
  const first = assistant('msg_first', 'glm-5.3', { input: 1, output: 1 })

  // Same first line, so a "did it start the same" test passes. Longer, so the stored offset
  // lands in the middle of the new second line, not at a line break.
  test('is read again from the start when the stored offset no longer sits on a line break', async () => {
    const path = write('-work-app/s1.jsonl', [first, assistant('msg_old', 'glm-5.3', { input: 2, output: 2 })])
    const { ledger } = await scan()
    writeFileSync(path, [first, assistant('msg_new', 'glm-5.3', { input: 7, output: 7, cacheRead: 123456789, cacheWrite: 987654321 })].join('\n') + '\n')
    await scanProfile(dir, ledger)
    expect(ledger.calls.msg_new).toBeDefined()
    expect(unreadableTotal(ledger)).toBe(0)
  })

  // Bigger than before and falling on a line break by luck: only the first line can tell.
  test('is read again from the start when its first line is not the one it began with', async () => {
    const one = assistant('msg_a', 'glm-5.3', { input: 1, output: 1 })
    const path = write('-work-app/s1.jsonl', [one, one.replace('msg_a', 'msg_b')])
    const { ledger } = await scan()
    const swapped = [assistant('msg_x', 'glm-5.3', { input: 1, output: 1 }), assistant('msg_y', 'glm-5.3', { input: 1, output: 1 }), assistant('msg_z', 'glm-5.3', { input: 1, output: 1 })]
    writeFileSync(path, swapped.join('\n') + '\n')
    expect(statSync(path).size).toBeGreaterThan(ledger.files['-work-app/s1.jsonl']!.offset)
    await scanProfile(dir, ledger)
    expect(['msg_x', 'msg_y', 'msg_z'].every((id) => ledger.calls[id])).toBe(true)
  })

  // Emptied, the file is not read, so nothing new would be written for it. The old position
  // and fingerprint must go, or the file growing back with the same first line would be
  // resumed in the middle.
  test('a transcript truncated to nothing forgets where it was, and is read whole when it grows back', async () => {
    const l1 = assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })
    const path = write('-work-app/s1.jsonl', [l1, assistant('msg_2', 'glm-5.3', { input: 2, output: 2 })])
    const { ledger } = await scan()
    writeFileSync(path, '')
    await scanProfile(dir, ledger)
    expect(ledger.files['-work-app/s1.jsonl']).toBeUndefined()
    // Back with the same first line and a replacement for the second of the same length.
    writeFileSync(path, [l1, assistant('msg_3', 'glm-5.3', { input: 3, output: 3 }), assistant('msg_4', 'glm-5.3', { input: 4, output: 4 })].join('\n') + '\n')
    await scanProfile(dir, ledger)
    expect(Object.keys(ledger.calls).sort()).toEqual(['msg_1', 'msg_2', 'msg_3', 'msg_4'])
  })

  // Rewound, then grown past its old size before the next pass: still bigger, still the same
  // first line, and the old position still falls on a line break. Only what lies just before the
  // position can tell that the file there is no longer what was read.
  test('is read again from the start when what lies before the stored position has changed', async () => {
    const lines = (ids: string[]) => ids.map((id) => assistant(id, 'glm-5.3', { input: 1, output: 1 }))
    const path = write('-work-app/s1.jsonl', lines(['msg_a', 'msg_b', 'msg_c', 'msg_d']))
    const { ledger } = await scan()
    const old = ledger.files['-work-app/s1.jsonl']!.offset
    // Same first line, same line lengths (so the old offset is still a line break), other calls
    // after it, and more of them than before.
    writeFileSync(path, lines(['msg_a', 'msg_w', 'msg_x', 'msg_y', 'msg_z']).join('\n') + '\n')
    expect(statSync(path).size).toBeGreaterThan(old)
    await scanProfile(dir, ledger)
    expect(['msg_w', 'msg_x', 'msg_y', 'msg_z'].every((id) => ledger.calls[id])).toBe(true)
  })

  test('an ordinary append is still read from where it stopped', async () => {
    const path = write('-work-app/s1.jsonl', [first])
    const { ledger } = await scan()
    const added = assistant('msg_2', 'glm-5.3', { input: 5, output: 5 }) + '\n'
    appendFileSync(path, added)
    const again = await scanProfile(dir, ledger)
    expect(again.bytesRead).toBe(Buffer.byteLength(added))
  })
})

describe('a line longer than a read', () => {
  // Tool results and images make single lines of megabytes. The reader takes 1 MiB at a time,
  // so such a line is assembled from several reads.
  test('is assembled from several reads, and the line after it is still counted', async () => {
    const big = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(3_500_000) } })
    write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 1, output: 1 }), big, assistant('msg_2', 'glm-5.3', { input: 2, output: 2 }), big.replace('user', 'assistant'), assistant('msg_3', 'glm-5.3', { input: 3, output: 3 })])
    const { ledger, result } = await scan()
    expect(Object.keys(ledger.calls).sort()).toEqual(['msg_1', 'msg_2', 'msg_3'])
    expect(result.unreadableLines).toBe(0)
  })

  test('a call whose own line is longer than a read is counted', async () => {
    const huge = JSON.parse(assistant('msg_huge', 'glm-5.3', { input: 9, output: 9 }))
    huge.message.content[0].text = 'y'.repeat(2_500_000)
    write('-work-app/s1.jsonl', [JSON.stringify(huge)])
    const { ledger } = await scan()
    expect(ledger.calls.msg_huge).toEqual(['glm-5.3', T0, 9, 9, null, null])
  })
})

describe('a transcript that cannot be read', () => {
  // Claude Code deletes old transcripts while a pass may be running, and permissions change.
  // One file must cost one file, not the whole report.
  test.skipIf(process.getuid?.() === 0)('is skipped and counted, and the rest are still read', async () => {
    const locked = write('-work-app/locked.jsonl', [assistant('msg_locked', 'glm-5.3', { input: 1, output: 1 })])
    write('-work-app/ok.jsonl', [assistant('msg_ok', 'glm-5.3', { input: 1, output: 1 })])
    chmodSync(locked, 0o000)
    try {
      const { ledger, result } = await scan()
      expect(Object.keys(ledger.calls)).toEqual(['msg_ok'])
      expect(result.skippedFiles).toBe(1)
      expect(ledger.files['-work-app/locked.jsonl']).toBeUndefined()
    } finally {
      chmodSync(locked, 0o644)
    }
  })

  test.skipIf(process.getuid?.() === 0)('and is read once it can be, since nothing was recorded for it', async () => {
    const locked = write('-work-app/locked.jsonl', [assistant('msg_locked', 'glm-5.3', { input: 1, output: 1 })])
    chmodSync(locked, 0o000)
    const { ledger } = await scan()
    chmodSync(locked, 0o644)
    await scanProfile(dir, ledger)
    expect(Object.keys(ledger.calls)).toEqual(['msg_locked'])
  })
})

describe('a ledger with a bad entry', () => {
  const at = () => join(dir, 'usage', 'glm.json')
  const put = (body: unknown) => {
    mkdirSync(join(dir, 'usage'), { recursive: true })
    writeFileSync(at(), JSON.stringify(body))
  }
  const good: [string, number, number, number, null, number] = ['glm-5.3', T0, 1, 2, null, 3]

  test.each([
    ['a call that is null', { version: 1, files: {}, calls: { msg_1: null } }],
    ['a call that is a string', { version: 1, files: {}, calls: { msg_1: 'x' } }],
    ['a call of the wrong length', { version: 1, files: {}, calls: { msg_1: ['m', 1, 2] } }],
    ['a call with a non-numeric count', { version: 1, files: {}, calls: { msg_1: ['m', 1, 'two', 3, null, null] } }],
    ['a negative count', { version: 1, files: {}, calls: { msg_1: ['m', 1, -2, 3, null, null] } }],
    ['a file entry with no offset', { version: 1, files: { 'a.jsonl': {} }, calls: {} }],
    ['a file entry whose tail is not text', { version: 1, files: { 'a.jsonl': { offset: 1, tail: 7 } }, calls: {} }],
    ['a file entry that is null', { version: 1, files: { 'a.jsonl': null }, calls: {} }],
  ])('is not read when it holds %s, so it takes the damaged path instead of crashing later', (_label, body) => {
    put(body)
    expect(loadLedger(at())).toBeNull()
  })

  test('is written into a directory only its owner can enter, since it records when and how much they worked', () => {
    saveLedger(join(dir, 'fresh', 'glm.json'), emptyLedger())
    expect(statSync(join(dir, 'fresh')).mode & 0o777).toBe(0o700)
  })

  test('leaves no temporary file behind when the final move fails', () => {
    mkdirSync(join(dir, 'usage', 'glm.json'), { recursive: true }) // a directory where the file should go
    expect(() => saveLedger(join(dir, 'usage', 'glm.json'), emptyLedger())).toThrow()
    expect(readdirSync(join(dir, 'usage')).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  test('is read when every entry is well formed', () => {
    put({ version: 1, files: { 'a.jsonl': { offset: 5, head: 'abc', bad: 1 } }, calls: { msg_1: good } })
    expect(loadLedger(at())?.calls.msg_1).toEqual(good)
  })
})

describe('the first line of a transcript is longer than the fingerprint reads', () => {
  const big = (id: string) => JSON.stringify({ type: 'assistant', message: { id, model: 'glm-5.3', content: [{ type: 'text', text: 'z'.repeat(100_000) }], usage: { input_tokens: 1, output_tokens: 1 } }, timestamp: new Date(T0 * 1000).toISOString() })

  // Same length, so the stored offset still sits on a line break; only the head can tell.
  test('still tells a transcript written over, by the part of it that was read', async () => {
    const path = write('-work-app/s1.jsonl', [big('msg_a')])
    const { ledger } = await scan()
    expect(ledger.files['-work-app/s1.jsonl']!.head).toBeDefined()
    writeFileSync(path, [big('msg_b'), assistant('msg_c', 'glm-5.3', { input: 3, output: 3 })].join('\n') + '\n')
    await scanProfile(dir, ledger)
    expect(Object.keys(ledger.calls).sort()).toEqual(['msg_a', 'msg_b', 'msg_c'])
  })
})

describe('the files that make up a ledger', () => {
  const p = (): Paths => ({ claudeDir: '', configFile: '', dirsRoot: '', cacheDir: '', binDir: '', defaultBinDir: '', usageDir: join(dir, 'usage') })

  test('are the ledger, its backup and every file set aside, and no other profile\'s', () => {
    mkdirSync(join(dir, 'usage'))
    for (const f of ['glm.json', 'glm.json.bak', 'glm.json.damaged', 'glm.json.damaged.2', 'glm.json.json', 'glm.jsonx', 'glm.json.other', 'other.json']) writeFileSync(join(dir, 'usage', f), '{}')
    expect(ledgerFiles(p(), 'glm').map((f) => f.split('/').pop()).sort()).toEqual(['glm.json', 'glm.json.bak', 'glm.json.damaged', 'glm.json.damaged.2'])
  })

  test('include what an interrupted write left, which no other file of the profile\'s lists', () => {
    mkdirSync(join(dir, 'usage'))
    for (const f of ['glm.json', 'glm.json.123.ab12cd34.tmp', 'glm.json.123.notahex.tmp', 'other.json.123.ab12cd34.tmp']) writeFileSync(join(dir, 'usage', f), '{}')
    expect(ledgerFiles(p(), 'glm').map((f) => f.split('/').pop()).sort()).toEqual(['glm.json', 'glm.json.123.ab12cd34.tmp'])
  })

  test('are none when the profile never had a ledger', () => {
    expect(ledgerFiles(p(), 'glm')).toEqual([])
  })
})

describe('prepareLedger', () => {
  const paths = (): Paths => ({ claudeDir: '', configFile: '', dirsRoot: '', cacheDir: '', binDir: '', defaultBinDir: '', usageDir: join(dir, 'usage') })
  const file = (suffix = '') => join(dir, 'usage', `glm.json${suffix}`)
  const ledgerWith = (...ids: string[]) => {
    const l = emptyLedger()
    for (const id of ids) l.calls[id] = ['glm-5.3', T0, 1, 1, null, null]
    return l
  }
  const read = (suffix: string) => JSON.parse(readFileSync(file(suffix), 'utf8'))

  test('starts empty, with nothing to say, when there is no ledger', () => {
    const r = prepareLedger(paths(), 'glm', { rebuild: false })
    expect(Object.keys(r.ledger.calls)).toEqual([])
    expect(r.notes).toEqual([])
  })

  test('hands back the ledger it finds', () => {
    saveLedger(file(), ledgerWith('a', 'b'))
    expect(Object.keys(prepareLedger(paths(), 'glm', { rebuild: false }).ledger.calls)).toEqual(['a', 'b'])
  })

  // Not damaged: newer. Replacing it with an empty version-1 ledger would take the history away
  // from the very ccprovider that wrote it, once Claude Code has pruned the transcripts.
  test('leaves a ledger from a newer ccprovider exactly as it is, and says so', () => {
    mkdirSync(join(dir, 'usage'))
    const newer = JSON.stringify({ version: 2, files: {}, calls: { msg_future: ['m', 1, 1, 1, null, null] } })
    writeFileSync(file(), newer)
    const r = prepareLedger(paths(), 'glm', { rebuild: false })
    expect(r.readOnly).toBe(true)
    expect(Object.keys(r.ledger.calls)).toEqual([])
    expect(readFileSync(file(), 'utf8')).toBe(newer)
    expect(existsSync(file('.damaged'))).toBe(false)
    expect(r.notes.map((n) => n.text).join(' ')).toContain('newer ccprovider')
    // A rebuild does not get to replace it either.
    const rebuilt = prepareLedger(paths(), 'glm', { rebuild: true })
    expect(rebuilt.readOnly).toBe(true)
    expect(readFileSync(file(), 'utf8')).toBe(newer)
    expect(existsSync(file('.bak'))).toBe(false)
  })

  test('sets an unreadable one aside and starts empty', () => {
    mkdirSync(join(dir, 'usage'))
    writeFileSync(file(), '{"version":1,"files":')
    const r = prepareLedger(paths(), 'glm', { rebuild: false })
    expect(Object.keys(r.ledger.calls)).toEqual([])
    expect(readFileSync(file('.damaged'), 'utf8')).toBe('{"version":1,"files":')
    expect(statSync(file('.damaged')).mode & 0o777).toBe(0o600)
    expect(r.notes.map((n) => n.text).join(' ')).toContain('glm.json.damaged')
  })

  // Left in place, an unreadable ledger would be copied aside again on every run, for ever, when
  // the transcripts are gone and nothing is ever scanned into it.
  test('replaces the unreadable ledger once it is set aside, so the next run finds a good one', () => {
    mkdirSync(join(dir, 'usage'))
    writeFileSync(file(), 'garbage')
    prepareLedger(paths(), 'glm', { rebuild: false })
    const again = prepareLedger(paths(), 'glm', { rebuild: false })
    expect(again.notes).toEqual([])
    expect(existsSync(file('.damaged.2'))).toBe(false)
    expect(readFileSync(file('.damaged'), 'utf8')).toBe('garbage')
    expect(loadLedger(file())).not.toBeNull()
  })

  // The first one set aside may be a newer ccprovider's ledger: the only copy of its history.
  test('never reuses the name of one it set aside before', () => {
    mkdirSync(join(dir, 'usage'))
    writeFileSync(file(), 'first damage')
    prepareLedger(paths(), 'glm', { rebuild: false })
    writeFileSync(file(), 'second damage')
    prepareLedger(paths(), 'glm', { rebuild: false })
    writeFileSync(file(), 'third damage')
    prepareLedger(paths(), 'glm', { rebuild: false })
    expect(readFileSync(file('.damaged'), 'utf8')).toBe('first damage')
    expect(readFileSync(file('.damaged.2'), 'utf8')).toBe('second damage')
    expect(readFileSync(file('.damaged.3'), 'utf8')).toBe('third damage')
  })

  test('a rebuild starts empty and keeps the ledger it replaces', () => {
    saveLedger(file(), ledgerWith('a', 'b', 'c'))
    const r = prepareLedger(paths(), 'glm', { rebuild: true })
    expect(Object.keys(r.ledger.calls)).toEqual([])
    expect(Object.keys(read('.bak').calls)).toEqual(['a', 'b', 'c'])
    expect(statSync(file('.bak')).mode & 0o777).toBe(0o600)
  })

  test('a second rebuild leaves the backup that holds more alone', () => {
    saveLedger(file(), ledgerWith('a', 'b', 'c'))
    prepareLedger(paths(), 'glm', { rebuild: true })
    saveLedger(file(), ledgerWith('a')) // what the first rebuild left
    const r = prepareLedger(paths(), 'glm', { rebuild: true })
    expect(Object.keys(read('.bak').calls)).toEqual(['a', 'b', 'c'])
    expect(r.notes.map((n) => n.text).join(' ')).toContain('holds more')
  })

  test('a ledger that has grown past the backup replaces it', () => {
    saveLedger(file('.bak'), ledgerWith('a'))
    saveLedger(file(), ledgerWith('a', 'b'))
    prepareLedger(paths(), 'glm', { rebuild: true })
    expect(Object.keys(read('.bak').calls)).toEqual(['a', 'b'])
  })

  test('a rebuild of an unreadable ledger sets it aside and does not make a backup of it', () => {
    mkdirSync(join(dir, 'usage'))
    writeFileSync(file(), 'garbage')
    prepareLedger(paths(), 'glm', { rebuild: true })
    expect(readFileSync(file('.damaged'), 'utf8')).toBe('garbage')
    expect(existsSync(file('.bak'))).toBe(false)
  })
})

describe('a long scan', () => {
  test('reports progress against the total it expects', async () => {
    write('-work-app/a.jsonl', [assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })])
    write('-work-app/b.jsonl', [assistant('msg_2', 'glm-5.3', { input: 1, output: 1 })])
    const seen: Array<[number, number]> = []
    const result = await scanProfile(dir, emptyLedger(), { onProgress: (done, total) => seen.push([done, total]) })
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(([, total]) => total === result.bytesRead)).toBe(true)
    expect(seen.at(-1)![0]).toBe(result.bytesRead)
  })

  // A scan of gigabytes that is interrupted must not start over: the caller saves the ledger
  // at these points, and every offset in it is for a file that was read to its end.
  test('offers to save part way, between files', async () => {
    write('-work-app/a.jsonl', [assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })])
    write('-work-app/b.jsonl', [assistant('msg_2', 'glm-5.3', { input: 1, output: 1 })])
    write('-work-app/c.jsonl', [assistant('msg_3', 'glm-5.3', { input: 1, output: 1 })])
    const ledger = emptyLedger()
    const atCheckpoint: number[] = []
    await scanProfile(dir, ledger, { checkpointBytes: 1, onCheckpoint: () => atCheckpoint.push(Object.keys(ledger.files).length) })
    expect(atCheckpoint).toEqual([1, 2, 3])
  })
})

describe('progressPercent', () => {
  // The total is fixed when the pass starts; a transcript that grows meanwhile is read past it.
  test('is a whole percent and never past 100', () => {
    expect(progressPercent(0, 200)).toBe(0)
    expect(progressPercent(50, 200)).toBe(25)
    expect(progressPercent(250, 200)).toBe(100)
    expect(progressPercent(1, 0)).toBe(100)
  })
})

describe('aggregate', () => {
  const ledgerOf = (rows: Array<[string, string, number, number, number, number | null, number | null]>): Ledger => {
    const l = emptyLedger()
    for (const [id, model, ts, i, o, cr, cw] of rows) l.calls[id] = [model, ts, i, o, cr, cw]
    return l
  }

  test('sums per profile and model', () => {
    const rows = aggregate(
      {
        glm: ledgerOf([
          ['a', 'glm-5.3', T0, 100, 10, 50, 5],
          ['b', 'glm-5.3', T0, 200, 20, 150, 15],
          ['c', 'glm-5.3-flash', T0, 1, 2, 3, 4],
        ]),
        pclaude: ledgerOf([['d', 'claude-opus-5-5', T0, 7, 8, 9, 10]]),
      },
      {},
    )
    expect(rows).toEqual([
      { profile: 'glm', model: 'glm-5.3', calls: 2, input: 300, output: 30, cacheRead: 200, cacheWrite: 20, cacheReported: true },
      { profile: 'glm', model: 'glm-5.3-flash', calls: 1, input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cacheReported: true },
      { profile: 'pclaude', model: 'claude-opus-5-5', calls: 1, input: 7, output: 8, cacheRead: 9, cacheWrite: 10, cacheReported: true },
    ])
  })

  test('a model that never reported cache is marked, not shown as a 0% hit rate', () => {
    const [row] = aggregate({ glm: ledgerOf([['a', 'glm-5.3', T0, 100, 10, null, null]]) }, {})
    expect(row!.cacheReported).toBe(false)
    expect(row!.cacheRead).toBe(0)
  })

  test('a model that reported cache on some calls counts the others as zero', () => {
    const [row] = aggregate({ glm: ledgerOf([['a', 'glm-5.3', T0, 100, 10, null, null], ['b', 'glm-5.3', T0, 100, 10, 40, 0]]) }, {})
    expect(row!.cacheReported).toBe(true)
    expect(row!.cacheRead).toBe(40)
  })

  test('--since keeps calls from that moment on', () => {
    const l = ledgerOf([['old', 'glm-5.3', T0 - 3 * DAY, 100, 1, null, null], ['new', 'glm-5.3', T0, 5, 1, null, null]])
    const [row] = aggregate({ glm: l }, { since: T0 - DAY })
    expect(row!.calls).toBe(1)
    expect(row!.input).toBe(5)
  })

  test('--by day splits on the day, in order', () => {
    const l = ledgerOf([['a', 'glm-5.3', T0, 1, 1, null, null], ['b', 'glm-5.3', T0 + DAY, 2, 1, null, null], ['c', 'glm-5.3', T0 + DAY, 4, 1, null, null]])
    const utcDay = (s: number) => new Date(s * 1000).toISOString().slice(0, 10)
    const rows = aggregate({ glm: l }, { by: 'day', dayOf: utcDay })
    expect(rows.map((r) => [r.day, r.calls, r.input])).toEqual([['2026-10-10', 1, 1], ['2026-10-11', 2, 6]])
  })

  test('a profile with nothing in it gives no rows', () => {
    expect(aggregate({ glm: emptyLedger() }, {})).toEqual([])
  })
})

describe('parseSince', () => {
  const now = Date.UTC(2026, 9, 17, 12, 0, 0) / 1000
  test('7d is seven days back from now', () => {
    expect(parseSince('7d', now)).toBe(now - 7 * DAY)
  })
  test('a date is that day at local midnight', () => {
    expect(parseSince('2026-10-01', now)).toBe(new Date(2026, 9, 1).getTime() / 1000)
  })
  test.each(['', 'yesterday', '7', '0d', '-3d', '2026-13-40', '7days'])('refuses %p, naming the forms it takes', (v) => {
    expect(() => parseSince(v, now)).toThrow(ProfileError)
    expect(() => parseSince(v, now)).toThrow(/7d/)
  })
})

describe('the ledger file', () => {
  test('round-trips, is private, and a damaged one reads as absent', () => {
    const path = join(dir, 'usage', 'glm.json')
    const l = emptyLedger()
    l.calls.msg_1 = ['glm-5.3', T0, 1, 2, null, 3]
    l.files['-work-app/s1.jsonl'] = { offset: 123 }
    saveLedger(path, l)
    expect(loadLedger(path)).toEqual(l)
    expect(statSync(path).mode & 0o777).toBe(0o600)

    writeFileSync(path, '{"version":1,"calls":')
    expect(loadLedger(path)).toBeNull()
    expect(loadLedger(join(dir, 'usage', 'nope.json'))).toBeNull()
  })

  test('a ledger from a version this code does not know is not read', () => {
    const path = join(dir, 'usage', 'glm.json')
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 99, files: {}, calls: {} }))
    expect(loadLedger(path)).toBeNull()
  })

  test('holds ids, models, times and counts, and no conversation text', async () => {
    write('-work-app/s1.jsonl', [assistant('msg_1', 'glm-5.3', { input: 1, output: 1 })])
    const { ledger } = await scan()
    const path = join(dir, 'usage', 'glm.json')
    saveLedger(path, ledger)
    expect(statSync(path).size).toBeLessThan(500)
    expect(JSON.stringify(ledger)).not.toContain('a private reply')
  })
})

describe('renderUsage', () => {
  const rows = aggregate(
    {
      glm: (() => {
        const l = emptyLedger()
        l.calls.a = ['glm-5.3', T0, 1_250_000, 4_200, 8_000_000, 20_000]
        l.calls.b = ['glm-5.3-flash', T0, 900, 40, null, null]
        return l
      })(),
    },
    {},
  )
  const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '')

  test('shows compact counts, the hit rate, and a dash where no cache was reported', () => {
    const out = plain(renderUsage(rows, { subscription: new Set(), color: false }))
    expect(out).toContain('glm')
    expect(out).toContain('glm-5.3-flash')
    expect(out).toContain('1.3M') // input of glm-5.3
    expect(out).toContain('8.0M') // cache read
    expect(out).toMatch(/glm-5\.3\s+1\s+1\.3M\s+4\.2K\s+8\.0M\s+20\.0K\s+86%/) // 8.0M / (1.25M + 8.0M + 20K)
    expect(out).toMatch(/glm-5\.3-flash\s+1\s+900\s+40\s+—\s+—\s+—/)
  })

  // A model that does not report cache has input that was never going to be a hit, so
  // counting it in the total's denominator would pull the rate down for no reason.
  test('the total\'s hit rate leaves out models that do not report cache', () => {
    const l = emptyLedger()
    l.calls.a = ['with-cache', T0, 100, 10, 300, 0]
    l.calls.b = ['no-cache', T0, 900, 10, null, null]
    const out = plain(renderUsage(aggregate({ p: l }, {}), { subscription: new Set(), color: false }))
    expect(out).toMatch(/with-cache\s+1\s+100\s+10\s+300\s+0\s+75%/)
    expect(out).toMatch(/total\s+2\s+1\.0K\s+20\s+300\s+0\s+75%/)
  })

  // Piped to a file or a pager, colour codes are noise.
  test('has no colour codes unless asked for them', () => {
    expect(renderUsage(rows, { subscription: new Set(['glm']), color: false })).not.toContain('\x1b')
    expect(renderUsage(rows, { subscription: new Set(['glm']), color: true })).toContain('\x1b[1m')
  })

  test('says so when there is nothing to show', () => {
    expect(plain(renderUsage([], { subscription: new Set(), color: false }))).toContain('No usage')
  })
})

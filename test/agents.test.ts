import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_CATALOG,
  AGENT_SOURCE,
  EXPLORE_FILE,
  installAgents,
  listInstalled,
  readExplore,
  removeAgents,
  renderAgent,
  renderExplore,
  setExplore,
  syncAgents,
  type AgentSpec,
} from '../src/agents.js'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

const upstream = (name: string) =>
  `---\nname: ${name}\ndescription: "Reviews code."\ntools: Read, Grep\nmodel: inherit\n---\n\nYou review code.\n`

const spec = (id: string, body = upstream(id)): AgentSpec => ({
  id,
  summary: `${id} summary`,
  path: `04-quality-security/${id}.md`,
  sha256: sha(body),
  recommended: true,
})

const reviewer = spec('code-reviewer')
const debuggerSpec = spec('debugger')
const catalog = [reviewer, debuggerSpec]

let home: string
let dir: string
let claudeDir: string
let cacheDir: string
let fetched: string[]

/** Serves each catalog file's upstream body; anything else 404s. */
const fakeFetch = (bodies: Record<string, string> = {}): typeof fetch =>
  (async (url: string | URL) => {
    const u = String(url)
    fetched.push(u)
    for (const s of catalog) {
      if (u.endsWith(`/categories/${s.path}`)) return new Response(bodies[s.id] ?? upstream(s.id))
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch

const opts = (over: Partial<Parameters<typeof installAgents>[3]> = {}) => ({
  catalog,
  cacheDir,
  fetchImpl: fakeFetch(),
  ...over,
})

const agentFile = (id: string) => join(dir, 'agents', `${id}.md`)

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ccprov-agents-'))
  dir = join(home, 'dirs', 'glm')
  claudeDir = join(home, '.claude')
  cacheDir = join(home, 'cache')
  mkdirSync(dir, { recursive: true })
  mkdirSync(claudeDir, { recursive: true })
  fetched = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('renderAgent', () => {
  test('puts the marker, source and licence inside the frontmatter, body untouched', () => {
    const out = renderAgent(reviewer, upstream('code-reviewer'))
    const lines = out.split('\n')
    expect(lines[0]).toBe('---')
    expect(lines[1]).toStartWith('# ccprovider-agent id=code-reviewer ')
    expect(out).toContain(`https://github.com/${AGENT_SOURCE.repo}/blob/${AGENT_SOURCE.commit}/categories/${reviewer.path}`)
    expect(out).toContain(AGENT_SOURCE.copyright)
    expect(out).toContain('# Permission is hereby granted, free of charge')
    // Every inserted line is a YAML comment, so nothing reaches the model.
    const inserted = lines.slice(1, lines.indexOf('name: code-reviewer'))
    expect(inserted.every((l) => l === '#' || l.startsWith('# '))).toBe(true)
    expect(out.endsWith('---\n\nYou review code.\n')).toBe(true)
  })

  test('refuses content that does not open with frontmatter', () => {
    expect(() => renderAgent(reviewer, 'name: x\n')).toThrow()
  })
})

describe('installAgents', () => {
  test('fetches from the pinned commit and writes a managed file', async () => {
    const r = await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    expect(r).toEqual([{ id: 'code-reviewer', action: 'installed' }])
    expect(fetched[0]).toBe(
      `https://raw.githubusercontent.com/${AGENT_SOURCE.repo}/${AGENT_SOURCE.commit}/categories/${reviewer.path}`,
    )
    expect(readFileSync(agentFile('code-reviewer'), 'utf8')).toBe(renderAgent(reviewer, upstream('code-reviewer')))
  })

  test('a body whose hash does not match the pin is refused and nothing is written', async () => {
    const r = await installAgents(dir, claudeDir, ['code-reviewer'], opts({ fetchImpl: fakeFetch({ 'code-reviewer': 'tampered' }) }))
    expect(r[0]!.action).toBe('failed')
    expect(r[0]!.detail).toContain('sha256')
    expect(existsSync(agentFile('code-reviewer'))).toBe(false)
  })

  test('a second profile is served from the cache, not the network', async () => {
    await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    const other = join(home, 'dirs', 'kimi')
    mkdirSync(other, { recursive: true })
    fetched = []
    expect((await installAgents(other, claudeDir, ['code-reviewer'], opts()))[0]!.action).toBe('installed')
    expect(fetched).toEqual([])
  })

  test('an unknown ID is reported, not guessed at', async () => {
    const r = await installAgents(dir, claudeDir, ['nope'], opts())
    expect(r[0]!.action).toBe('failed')
    expect(fetched).toEqual([])
  })

  test('a same-named file it did not write is never overwritten', async () => {
    mkdirSync(join(dir, 'agents'))
    writeFileSync(agentFile('code-reviewer'), 'my own reviewer')
    const r = await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    expect(r[0]!.action).toBe('kept')
    expect(readFileSync(agentFile('code-reviewer'), 'utf8')).toBe('my own reviewer')
  })

  test('local edits to an installed agent are kept on reinstall', async () => {
    await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    writeFileSync(agentFile('code-reviewer'), readFileSync(agentFile('code-reviewer'), 'utf8') + 'my tweak\n')
    const r = await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    expect(r[0]!.action).toBe('kept')
    expect(readFileSync(agentFile('code-reviewer'), 'utf8')).toContain('my tweak')
  })

  test('installing twice is a no-op', async () => {
    await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    expect((await installAgents(dir, claudeDir, ['code-reviewer'], opts()))[0]!.action).toBe('unchanged')
  })

  test('the first agent turns a wholesale agents link into the profile’s own directory', async () => {
    mkdirSync(join(claudeDir, 'agents'))
    writeFileSync(join(claudeDir, 'agents', 'shared.md'), 'shared')
    symlinkSync(join(claudeDir, 'agents'), join(dir, 'agents'))
    await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    expect(lstatSync(join(dir, 'agents')).isDirectory()).toBe(true)
    expect(lstatSync(join(dir, 'agents', 'shared.md')).isSymbolicLink()).toBe(true)
    // Written into the profile, never through the link into ~/.claude.
    expect(existsSync(join(claudeDir, 'agents', 'code-reviewer.md'))).toBe(false)
  })
})

describe('listInstalled', () => {
  test('reads managed agents from their markers and flags edits', async () => {
    await installAgents(dir, claudeDir, ['code-reviewer', 'debugger'], opts())
    writeFileSync(agentFile('debugger'), readFileSync(agentFile('debugger'), 'utf8').replace('You review', 'You fix'))
    writeFileSync(agentFile('mine'), '---\nname: mine\n---\n')
    expect(listInstalled(dir, catalog)).toEqual([
      { id: 'code-reviewer', file: agentFile('code-reviewer'), modified: false, known: true },
      { id: 'debugger', file: agentFile('debugger'), modified: true, known: true },
    ])
  })

  test('nothing installed is an empty list, not an error', () => {
    expect(listInstalled(dir, catalog)).toEqual([])
  })
})

describe('removeAgents', () => {
  test('removes a managed agent', async () => {
    await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    expect(removeAgents(dir, ['code-reviewer'], { catalog })).toEqual([{ id: 'code-reviewer', action: 'removed' }])
    expect(existsSync(agentFile('code-reviewer'))).toBe(false)
  })

  test('keeps an edited agent unless forced', async () => {
    await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    writeFileSync(agentFile('code-reviewer'), readFileSync(agentFile('code-reviewer'), 'utf8') + 'edit\n')
    expect(removeAgents(dir, ['code-reviewer'], { catalog })[0]!.action).toBe('kept')
    expect(existsSync(agentFile('code-reviewer'))).toBe(true)
    expect(removeAgents(dir, ['code-reviewer'], { catalog, force: true })[0]!.action).toBe('removed')
  })

  test('never removes a file it did not write, even when forced', () => {
    mkdirSync(join(dir, 'agents'))
    writeFileSync(agentFile('code-reviewer'), 'mine')
    expect(removeAgents(dir, ['code-reviewer'], { catalog, force: true })[0]!.action).toBe('kept')
    expect(readFileSync(agentFile('code-reviewer'), 'utf8')).toBe('mine')
  })

  test('an agent that is not installed is reported as absent', () => {
    expect(removeAgents(dir, ['debugger'], { catalog })[0]!.action).toBe('absent')
  })
})

describe('syncAgents', () => {
  test('installs what is wanted and removes what was unticked', async () => {
    await installAgents(dir, claudeDir, ['code-reviewer'], opts())
    const r = await syncAgents(dir, claudeDir, ['debugger'], opts())
    expect(r).toContainEqual({ id: 'debugger', action: 'installed' })
    expect(r).toContainEqual({ id: 'code-reviewer', action: 'removed' })
    expect(listInstalled(dir, catalog).map((a) => a.id)).toEqual(['debugger'])
  })
})

describe('Explore override', () => {
  test('writes a read-only Explore on the chosen model and reads it back', () => {
    expect(setExplore(dir, claudeDir, 'haiku').action).toBe('installed')
    const text = readFileSync(join(dir, 'agents', EXPLORE_FILE), 'utf8')
    expect(text).toStartWith('---\n# ccprovider-agent id=explore ')
    expect(text).toContain('\nname: Explore\n')
    expect(text).toContain('\nmodel: haiku\n')
    expect(text).toContain('\ndisallowedTools: Write, Edit, NotebookEdit\n')
    expect(readExplore(dir)).toEqual({ model: 'haiku', modified: false })
  })

  test('a full model ID is accepted; something that could break the YAML is not', () => {
    expect(setExplore(dir, claudeDir, 'glm-5.3-flash').action).toBe('installed')
    expect(readExplore(dir)?.model).toBe('glm-5.3-flash')
    expect(() => setExplore(dir, claudeDir, 'haiku\nname: evil')).toThrow()
  })

  test('changing the model rewrites it; default removes only our file', () => {
    setExplore(dir, claudeDir, 'haiku')
    setExplore(dir, claudeDir, 'sonnet')
    expect(renderExplore('sonnet')).toBe(readFileSync(join(dir, 'agents', EXPLORE_FILE), 'utf8'))
    expect(setExplore(dir, claudeDir, null).action).toBe('removed')
    expect(readExplore(dir)).toBeNull()
  })

  test('a hand-written Explore is left alone', () => {
    mkdirSync(join(dir, 'agents'))
    writeFileSync(join(dir, 'agents', EXPLORE_FILE), '---\nname: Explore\n---\nmine\n')
    expect(setExplore(dir, claudeDir, 'haiku').action).toBe('kept')
    expect(setExplore(dir, claudeDir, null).action).toBe('kept')
    expect(readExplore(dir)).toBeNull()
  })
})

describe('the shipped catalog', () => {
  test('pins one commit and a hash per file, with unique IDs', () => {
    expect(AGENT_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/)
    const ids = AGENT_CATALOG.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of AGENT_CATALOG) {
      expect(a.id).toMatch(/^[a-z0-9][a-z0-9-]*$/)
      expect(a.id).not.toBe('explore')
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(a.path).toEndWith(`/${a.id}.md`)
    }
    expect(AGENT_CATALOG.filter((a) => a.recommended).map((a) => a.id)).toEqual([
      'code-reviewer', 'architect-reviewer', 'test-automator', 'debugger', 'security-auditor',
    ])
  })

  // Hits GitHub, so opt-in: proves every pin still resolves to the bytes it names.
  test.skipIf(process.env.CCPROVIDER_NETWORK_TESTS !== '1')('every pinned file still matches its hash', async () => {
    const r = await installAgents(dir, claudeDir, AGENT_CATALOG.map((a) => a.id), { cacheDir, fetchImpl: fetch })
    expect(r.filter((x) => x.action !== 'installed')).toEqual([])
  }, 60_000)
})

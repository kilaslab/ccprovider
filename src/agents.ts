import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensureOwnAgentsDir } from './configdir.js'

/**
 * Subagents from an open-source collection, installed into one profile's own config.
 *
 * Taken from VoltAgent/awesome-claude-code-subagents (MIT) rather than written here, and
 * pinned to one commit with a hash per file: what a user installs is exactly what was
 * reviewed when the pin was set, no matter what the repository does afterwards. Each
 * file's `model:` is a tier name or `inherit`, so it resolves through the profile's
 * own tier mapping — `sonnet` on a GLM profile is a GLM model.
 *
 * The files on disk are the record of what is installed. A file is ccprovider's only if
 * it carries the marker comment; anything else in the directory is never overwritten or
 * removed, and an installed agent the user has since edited is kept unless forced.
 */

export const AGENT_SOURCE = {
  repo: 'VoltAgent/awesome-claude-code-subagents',
  commit: '408d3c9eee2d0c75c12a3abb5de29e53c2ca6b9e',
  copyright: 'Copyright (c) 2025 VoltAgent',
} as const

export interface AgentSpec {
  /** File name without `.md`, and the agent's `name:`. */
  id: string
  summary: string
  /** Path under the repository's `categories/`. */
  path: string
  /** Of the upstream file at `AGENT_SOURCE.commit`. */
  sha256: string
  /** Ticked by default when a profile is added. */
  recommended: boolean
}

/** Hashes taken from the files at the pinned commit on 2026-10-16. Moving the pin means
 *  re-reading the files and re-taking every hash; `CCPROVIDER_NETWORK_TESTS=1 bun test`
 *  checks them all against GitHub. */
export const AGENT_CATALOG: readonly AgentSpec[] = [
  { id: 'code-reviewer', summary: 'review changes with fresh eyes', path: '04-quality-security/code-reviewer.md', sha256: 'cf8235884dd8b4bc15aa20cc822f727ecbde2b65823b7ba2b027a638804dfc78', recommended: true },
  { id: 'architect-reviewer', summary: 'senior design review and trade-offs', path: '04-quality-security/architect-reviewer.md', sha256: '7c7e8301852b2a0b44404955272ac1d6156dedab9a0aad519a9f25d49d8616d4', recommended: true },
  { id: 'test-automator', summary: 'write and extend tests', path: '04-quality-security/test-automator.md', sha256: '811f2e71b5f74f1f0780da4b657737df056ef07eec2dd85b2492d1d58edd5dba', recommended: true },
  { id: 'debugger', summary: 'find the root cause of a bug', path: '04-quality-security/debugger.md', sha256: '7e39938967cb1313f803a603e215ad0d8c778e0913328ccee220bb8470d617f3', recommended: true },
  { id: 'security-auditor', summary: 'look for security holes before merge', path: '04-quality-security/security-auditor.md', sha256: '62b0e511c9e0d8f1ec02b2fe0f4a1806134c850508c55420f558457225b1eb7d', recommended: true },
  { id: 'qa-expert', summary: 'QA strategy and test plans', path: '04-quality-security/qa-expert.md', sha256: '26e34e3ef0185fa230b1ab396de4339c7947fc59dc6503361377c7ab1f0c3abf', recommended: false },
  { id: 'refactoring-specialist', summary: 'restructure code without changing behaviour', path: '06-developer-experience/refactoring-specialist.md', sha256: '25f431ff0e8f6c219a0b1b60e46f226d82f26e29f286420dd8d11da80f802ff4', recommended: false },
  { id: 'performance-engineer', summary: 'profile and speed things up', path: '04-quality-security/performance-engineer.md', sha256: '3f3f6ac069818a21fbd106ce7d2d374fb32342dc1197a8148bc6f9ae8fdde277', recommended: false },
  { id: 'documentation-engineer', summary: 'write and maintain docs', path: '06-developer-experience/documentation-engineer.md', sha256: '0c7dc92e14797c11604b74f1a748a9f76bcf2681753fe6311fe00392af7cb833', recommended: false },
]

/** The upstream licence's permission notice, which MIT asks to travel with every copy.
 *  It goes into the frontmatter as comments, so it never reaches the model. */
const MIT_NOTICE = `MIT License

${AGENT_SOURCE.copyright}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

export const EXPLORE_ID = 'explore'
/** A user agent named `Explore` replaces Claude Code's built-in one. */
export const EXPLORE_FILE = 'Explore.md'

const MARKER_RE = /^---\n# ccprovider-agent id=([a-z0-9][a-z0-9-]*) /
const FETCH_TIMEOUT = 15_000

const marker = (id: string, how: string) => `# ccprovider-agent id=${id} - managed by ccprovider; ${how}`
const comment = (text: string) => text.split('\n').map((l) => (l ? `# ${l}` : '#')).join('\n')

export function rawUrl(spec: AgentSpec): string {
  return `https://raw.githubusercontent.com/${AGENT_SOURCE.repo}/${AGENT_SOURCE.commit}/categories/${spec.path}`
}

export function sourceUrl(spec: AgentSpec): string {
  return `https://github.com/${AGENT_SOURCE.repo}/blob/${AGENT_SOURCE.commit}/categories/${spec.path}`
}

/** What ccprovider inserts after the opening `---`. Deterministic, so an installed file
 *  can be checked for local edits without the network. */
function header(spec: AgentSpec): string {
  return [
    marker(spec.id, `\`ccprovider agents rm <profile> ${spec.id}\` removes it`),
    `# Source: ${sourceUrl(spec)}`,
    comment(MIT_NOTICE),
  ].join('\n') + '\n'
}

export function renderAgent(spec: AgentSpec, upstream: string): string {
  if (!upstream.startsWith('---\n')) throw new Error(`${spec.id}: the upstream file does not open with frontmatter`)
  return '---\n' + header(spec) + upstream.slice(4)
}

/** True when the file is exactly what `renderAgent` wrote: our header, then the pinned
 *  upstream bytes. */
function isPristine(spec: AgentSpec, text: string): boolean {
  const prefix = '---\n' + header(spec)
  return text.startsWith(prefix) && sha256('---\n' + text.slice(prefix.length)) === spec.sha256
}

const EXPLORE_PROMPT = `You are a fast, read-only search agent. Your job is to find things in a codebase and
report back, so the caller does not have to read every file itself.

- Search broadly first (Glob, Grep), then read only the excerpts that answer the question.
- Match the depth to the thoroughness you were asked for: quick, medium or very thorough.
- Never create, edit or delete files. Run only commands that read.
- Report conclusions, not file dumps: the answer first, then the evidence as
  \`path:line\` references and short excerpts. Say plainly what you could not find.
`

/** The Explore override: Claude Code's read-only search agent, on a model of the
 *  profile's choosing. Its own words, since there is no upstream file to take. */
export function renderExplore(model: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/[\]-]*$/.test(model)) {
    throw new Error(`"${model}" is not a model name ccprovider will write into an agent file`)
  }
  return [
    '---',
    marker(EXPLORE_ID, '`ccprovider agents explore <profile> default` removes it'),
    'name: Explore',
    'description: Fast read-only agent for finding files, searching code and answering questions about a codebase. Use it when the answer means sweeping many files and only the conclusion is needed. Say how thorough to be - quick, medium or very thorough.',
    `model: ${model}`,
    'disallowedTools: Write, Edit, NotebookEdit',
    '---',
    '',
    EXPLORE_PROMPT,
  ].join('\n')
}

/** The model of a ccprovider-written Explore override, or null when the built-in one is
 *  in use (no file, or one the user wrote themselves). */
export function readExplore(dir: string): { model: string; modified: boolean } | null {
  const text = readSafe(join(dir, 'agents', EXPLORE_FILE))
  if (text == null || managedId(text) !== EXPLORE_ID) return null
  const model = /\nmodel: (.+)\n/.exec(text)?.[1]?.trim()
  if (!model) return { model: '?', modified: true }
  let expected: string | null = null
  try { expected = renderExplore(model) } catch { /* unrenderable means edited */ }
  return { model, modified: text !== expected }
}

export type AgentAction = 'installed' | 'unchanged' | 'removed' | 'kept' | 'absent' | 'failed'
export interface AgentResult {
  id: string
  action: AgentAction
  detail?: string
}

export interface InstallOpts {
  cacheDir: string
  fetchImpl?: typeof fetch
  catalog?: readonly AgentSpec[]
}

export async function installAgents(dir: string, claudeDir: string, ids: string[], opts: InstallOpts): Promise<AgentResult[]> {
  const catalog = opts.catalog ?? AGENT_CATALOG
  const results: AgentResult[] = []
  for (const id of ids) {
    const spec = catalog.find((a) => a.id === id)
    if (!spec) {
      results.push({ id, action: 'failed', detail: `not in the catalog (${catalog.map((a) => a.id).join(', ')})` })
      continue
    }
    const file = join(dir, 'agents', `${id}.md`)
    const existing = readSafe(file)
    if (existing != null) {
      if (managedId(existing) !== id) results.push({ id, action: 'kept', detail: `${file} was not written by ccprovider` })
      else if (isPristine(spec, existing)) results.push({ id, action: 'unchanged' })
      else results.push({ id, action: 'kept', detail: 'edited since it was installed; your edits are left as they are' })
      continue
    }
    try {
      const upstream = await fetchAgent(spec, opts)
      writeAtomic(join(ensureOwnAgentsDir(dir, claudeDir), `${id}.md`), renderAgent(spec, upstream))
      results.push({ id, action: 'installed' })
    } catch (e) {
      results.push({ id, action: 'failed', detail: (e as Error).message })
    }
  }
  return results
}

export function removeAgents(dir: string, ids: string[], opts: { force?: boolean; catalog?: readonly AgentSpec[] } = {}): AgentResult[] {
  const catalog = opts.catalog ?? AGENT_CATALOG
  return ids.map((id): AgentResult => {
    const file = join(dir, 'agents', `${id}.md`)
    const text = readSafe(file)
    if (text == null) return { id, action: 'absent' }
    if (managedId(text) !== id) return { id, action: 'kept', detail: `${file} was not written by ccprovider` }
    const spec = catalog.find((a) => a.id === id)
    if (spec && !isPristine(spec, text) && !opts.force) {
      return { id, action: 'kept', detail: 'edited since it was installed; pass -y to remove it anyway' }
    }
    unlinkSync(file)
    return { id, action: 'removed' }
  })
}

/** Make the profile's catalog agents exactly `wanted`: install what is missing, remove
 *  what was unticked. Agents the user edited or wrote themselves are left alone. */
export async function syncAgents(dir: string, claudeDir: string, wanted: string[], opts: InstallOpts): Promise<AgentResult[]> {
  const installed = listInstalled(dir, opts.catalog).filter((a) => a.known).map((a) => a.id)
  const drop = installed.filter((id) => !wanted.includes(id))
  return [
    ...(await installAgents(dir, claudeDir, wanted, opts)).filter((r) => r.action !== 'unchanged'),
    ...removeAgents(dir, drop, { catalog: opts.catalog }),
  ]
}

/** Point Explore at `model`, or hand it back to the built-in agent with null. */
export function setExplore(dir: string, claudeDir: string, model: string | null): AgentResult {
  const file = join(dir, 'agents', EXPLORE_FILE)
  const text = readSafe(file)
  if (text != null && managedId(text) !== EXPLORE_ID) {
    return { id: EXPLORE_ID, action: 'kept', detail: `${file} was not written by ccprovider` }
  }
  if (model == null) {
    if (text == null) return { id: EXPLORE_ID, action: 'absent' }
    unlinkSync(file)
    return { id: EXPLORE_ID, action: 'removed' }
  }
  const rendered = renderExplore(model)
  if (text === rendered) return { id: EXPLORE_ID, action: 'unchanged' }
  writeAtomic(join(ensureOwnAgentsDir(dir, claudeDir), EXPLORE_FILE), rendered)
  return { id: EXPLORE_ID, action: 'installed' }
}

export interface InstalledAgent {
  id: string
  file: string
  modified: boolean
  /** False for an agent a later ccprovider dropped from its catalog. */
  known: boolean
}

/** Catalog agents ccprovider installed in this profile, by their marker. The Explore
 *  override is reported separately by `readExplore`. */
export function listInstalled(dir: string, catalog: readonly AgentSpec[] = AGENT_CATALOG): InstalledAgent[] {
  const agentsDir = join(dir, 'agents')
  let names: string[]
  try {
    if (!lstatSync(agentsDir).isDirectory()) return []
    names = readdirSync(agentsDir).sort()
  } catch {
    return []
  }
  const out: InstalledAgent[] = []
  for (const name of names) {
    const file = join(agentsDir, name)
    if (!name.endsWith('.md') || lstatSync(file).isSymbolicLink()) continue
    const text = readSafe(file)
    const id = text == null ? null : managedId(text)
    if (!id || id === EXPLORE_ID || `${id}.md` !== name) continue
    const spec = catalog.find((a) => a.id === id)
    out.push({ id, file, modified: spec ? !isPristine(spec, text!) : false, known: !!spec })
  }
  return out
}

/** The pinned upstream file, from the cache when another profile already fetched it. */
async function fetchAgent(spec: AgentSpec, opts: InstallOpts): Promise<string> {
  const cached = join(opts.cacheDir, 'agents', `${spec.sha256}.md`)
  const hit = readSafe(cached)
  if (hit != null && sha256(hit) === spec.sha256) return hit

  const res = await (opts.fetchImpl ?? fetch)(rawUrl(spec), { signal: AbortSignal.timeout(FETCH_TIMEOUT) })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${rawUrl(spec)}`)
  const body = await res.text()
  if (sha256(body) !== spec.sha256) {
    throw new Error(`the file at ${rawUrl(spec)} does not match its pinned sha256, so it was not installed`)
  }
  mkdirSync(join(opts.cacheDir, 'agents'), { recursive: true })
  writeAtomic(cached, body)
  return body
}

function managedId(text: string): string | null {
  return MARKER_RE.exec(text)?.[1] ?? null
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function readSafe(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

function writeAtomic(path: string, contents: string): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, contents)
  renameSync(tmp, path)
}

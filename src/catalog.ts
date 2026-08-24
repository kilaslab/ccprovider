import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface ModelInfo {
  id: string
  label: string
  contextLength: number | null
  maxOutput: number | null
  /** Claude Code is a tool-calling agent. A model without tool support cannot drive
   *  it at all — it fails in ways that look like the agent being broken. */
  supportsTools: boolean
  /** Screenshots and pasted images only work if the model accepts image input. */
  supportsImages: boolean
  promptPrice: number | null
  completionPrice: number | null
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export class CatalogError extends Error {}

/** OpenRouter's catalog is public and carries per-model capability metadata. */
export async function fetchOpenRouterCatalog(opts: {
  cacheDir: string
  refresh?: boolean
  fetchImpl?: typeof fetch
}): Promise<ModelInfo[]> {
  const cacheFile = join(opts.cacheDir, 'openrouter-models.json')
  if (!opts.refresh) {
    const cached = readCache(cacheFile)
    if (cached) return cached
  }

  const doFetch = opts.fetchImpl ?? fetch
  let raw: unknown
  try {
    const res = await doFetch('https://openrouter.ai/api/v1/models', {
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new CatalogError(`OpenRouter returned HTTP ${res.status}`)
    raw = await res.json()
  } catch (e) {
    // Offline or rate-limited: a stale catalog beats no catalog.
    const stale = readCache(cacheFile, Infinity)
    if (stale) return stale
    throw new CatalogError(`Could not reach OpenRouter's model list: ${(e as Error).message}`)
  }

  const models = parseOpenRouter(raw)
  writeCache(cacheFile, models)
  return models
}

export function parseOpenRouter(raw: unknown): ModelInfo[] {
  const data = (raw as { data?: unknown[] })?.data
  if (!Array.isArray(data)) throw new CatalogError('Unexpected response shape from OpenRouter')

  return data.map((m) => {
    const r = m as Record<string, any>
    const params: string[] = Array.isArray(r.supported_parameters) ? r.supported_parameters : []
    const modalities: string[] = r.architecture?.input_modalities ?? []
    return {
      id: String(r.id),
      label: String(r.name ?? r.id),
      contextLength: numOrNull(r.context_length),
      maxOutput: numOrNull(r.top_provider?.max_completion_tokens),
      supportsTools: params.includes('tools'),
      supportsImages: modalities.includes('image'),
      promptPrice: numOrNull(Number(r.pricing?.prompt)),
      completionPrice: numOrNull(Number(r.pricing?.completion)),
    }
  })
}

/** Providers other than OpenRouter expose an OpenAI-shaped list behind their key:
 *  bare IDs, no capability metadata. Still better than typing model names by hand. */
export async function fetchGenericCatalog(
  modelsUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelInfo[]> {
  const res = await fetchImpl(modelsUrl, {
    headers: { authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new CatalogError(`${modelsUrl} returned HTTP ${res.status}`)
  const raw = (await res.json()) as any
  const list = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : null
  if (!list) throw new CatalogError(`Unexpected model-list shape from ${modelsUrl}`)

  return list
    .map((m: any) => (typeof m === 'string' ? m : m?.id))
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
    .map((id: string) => ({
      id,
      label: id,
      contextLength: null,
      maxOutput: null,
      // Unknown, not false: these providers publish no capability metadata, and
      // treating unknown as unsupported would hide every model they offer.
      supportsTools: true,
      supportsImages: false,
      promptPrice: null,
      completionPrice: null,
    }))
}

/** The filter that matters: drop models that cannot drive a tool-calling agent. */
export function toolCapable(models: ModelInfo[]): ModelInfo[] {
  return models.filter((m) => m.supportsTools)
}

export function searchModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase()
  if (!q) return models
  return models.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q))
}

export function formatPrice(m: ModelInfo): string {
  if (m.promptPrice == null) return ''
  const perM = (n: number) => `$${(n * 1_000_000).toFixed(2)}`
  return `${perM(m.promptPrice)}/${m.completionPrice != null ? perM(m.completionPrice) : '?'} per M`
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

function readCache(file: string, ttl = CACHE_TTL_MS): ModelInfo[] | null {
  if (!existsSync(file)) return null
  try {
    const { fetchedAt, models } = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(models)) return null
    if (ttl !== Infinity && Date.now() - fetchedAt > ttl) return null
    return models as ModelInfo[]
  } catch {
    return null
  }
}

function writeCache(file: string, models: ModelInfo[]): void {
  try {
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), models }))
  } catch {
    /* cache is an optimisation, never fatal */
  }
}

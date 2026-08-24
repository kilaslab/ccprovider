import { stripSuffix } from './types.js'

export type EndpointVerdict =
  | { kind: 'anthropic'; status: number }
  | { kind: 'openai-only'; status: number }
  | { kind: 'unreachable'; detail: string }
  /** The server answers before it routes, so the URL cannot be judged from outside.
   *  Only an authenticated request can settle it. */
  | { kind: 'inconclusive'; status: number }
  | { kind: 'unknown'; status: number }

/** A path that cannot legitimately exist, used as a control. If it answers the same
 *  as /v1/messages, the server is authenticating before routing and its response to
 *  /v1/messages carries no information about whether that route exists. */
const CONTROL_PATH = '/v1/__ccprovider_control_probe__'

const TIMEOUT = 15_000

/**
 * Decide whether a base URL speaks the Anthropic Messages format.
 *
 * An unauthenticated POST is enough: 401/403 means the route exists and wants a key,
 * 404 means it is not there. That is more reliable than reading a provider's docs,
 * which lag their actual API.
 */
export async function probeEndpoint(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<EndpointVerdict> {
  const root = baseUrl.replace(/\/$/, '')
  let status: number
  let control: number
  try {
    // Both requests, so the control can tell a real route from a blanket auth wall.
    // Measured across providers: DeepSeek answers identically on any path, while
    // OpenRouter 404s a bogus one — so without this, a typo'd DeepSeek URL would be
    // reported as a working Anthropic endpoint and only fail later, mid-session.
    const [a, b] = await Promise.all([
      post(root + '/v1/messages', fetchImpl),
      post(root + CONTROL_PATH, fetchImpl),
    ])
    status = a
    control = b
  } catch (e) {
    return { kind: 'unreachable', detail: (e as Error).message }
  }

  const authLike = status === 401 || status === 403
  const parsedOurBody = status === 400 || status === 422

  // The control got the same answer: the response says nothing about routing.
  if (authLike && control === status) return { kind: 'inconclusive', status }

  // It read our body and complained about its contents — the route is real and
  // speaks something request-shaped.
  if (parsedOurBody && control !== status) return { kind: 'anthropic', status }
  if (authLike) return { kind: 'anthropic', status }
  if (status >= 200 && status < 300) return { kind: 'anthropic', status }

  if (status === 404 || status === 405) {
    // Might be an OpenAI-format endpoint. Worth distinguishing, because the fix is
    // specific and actionable rather than "check your URL".
    if (await looksOpenAI(baseUrl, fetchImpl)) return { kind: 'openai-only', status }
    return { kind: 'unknown', status }
  }

  return { kind: 'unknown', status }
}

async function post(url: string, fetchImpl: typeof fetch): Promise<number> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(TIMEOUT),
  })
  return res.status
}

async function looksOpenAI(baseUrl: string, fetchImpl: typeof fetch): Promise<boolean> {
  const root = baseUrl.replace(/\/$/, '')
  for (const path of ['/chat/completions', '/v1/chat/completions']) {
    try {
      const res = await fetchImpl(root + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(TIMEOUT),
      })
      if ([400, 401, 403, 422].includes(res.status)) return true
    } catch {
      /* try the next path */
    }
  }
  return false
}

export interface ModelProbe {
  ok: boolean
  status?: number
  error?: string
}

/** Send the smallest possible real request through one model ID. This is what
 *  catches an alias slot pointing at a model the provider does not have. */
export async function probeModel(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelProbe> {
  // Claude Code strips the [1m] suffix before the ID reaches the provider; so must we,
  // or every suffixed alias would look broken.
  const id = stripSuffix(model)
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: id, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(TIMEOUT),
    })
    if (res.ok) return { ok: true, status: res.status }
    const text = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: summarise(text, res.status) }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

function summarise(body: string, status: number): string {
  try {
    const j = JSON.parse(body)
    const msg = j?.error?.message ?? j?.message ?? j?.error
    if (typeof msg === 'string') return msg.slice(0, 200)
  } catch {
    /* not JSON */
  }
  return body.slice(0, 200) || `HTTP ${status}`
}

export const OPENAI_GUIDANCE = (baseUrl: string) =>
  `That endpoint speaks the OpenAI format (/chat/completions), not the Anthropic
Messages format Claude Code requires. ccprovider does not translate between them.

Front it with LiteLLM, which does:

  pip install 'litellm[proxy]'
  litellm --model openai/YOUR_MODEL --api_base ${baseUrl}

then point ccprovider at  http://localhost:4000`

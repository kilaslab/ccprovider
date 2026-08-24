import type { Preset } from './types.js'

/** Fraction of a model's real context window to place the auto-compact trigger at.
 *  DeepSeek's own documented config uses 768k of a 1M window; we follow that ratio. */
export const COMPACT_RATIO = 0.75

export function compactWindowFor(contextLength: number): number {
  return Math.floor(contextLength * COMPACT_RATIO)
}

/** Every base URL below was probed and answers the Anthropic Messages format.
 *
 *  Alias model IDs are *starting points*, not gospel — provider lineups turn over fast.
 *  The wizard fetches the live catalog with the user's key wherever `modelsUrl` is set
 *  and prefers what it finds, so a stale default here self-corrects at setup time.
 *  `sourced` records where each mapping came from, so it is clear which are guesses. */
export const PRESETS: Preset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    docs: 'https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/',
    modelsUrl: 'https://api.deepseek.com/v1/models',
    sourced: 'deepseek-official-docs',
    aliases: {
      opus: 'deepseek-v4-pro[1m]',
      sonnet: 'deepseek-v4-pro[1m]',
      haiku: 'deepseek-v4-flash',
      subagent: 'deepseek-v4-flash',
    },
    defaultModel: 'deepseek-v4-pro[1m]',
    contextTokens: 1048576,
    autoCompactWindow: 786432,
    effortLevel: 'max',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter  (400+ models, live catalog)',
    baseUrl: 'https://openrouter.ai/api',
    docs: 'https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    liveCatalog: 'openrouter',
    sourced: 'openrouter-docs',
    blankApiKey: true,
  },
  {
    id: 'kimi',
    label: 'Kimi / Moonshot',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    docs: 'https://platform.kimi.ai/docs/guide/agent-support',
    modelsUrl: 'https://api.moonshot.ai/v1/models',
    sourced: 'kimi-docs-model-list',
    aliases: {
      opus: 'kimi-k3[1m]',
      sonnet: 'kimi-k3[1m]',
      haiku: 'kimi-k2.7-code-highspeed',
      subagent: 'kimi-k2.7-code-highspeed',
    },
    defaultModel: 'kimi-k3[1m]',
    contextTokens: 1048576,
    autoCompactWindow: 786432,
  },
  {
    id: 'glm',
    label: 'GLM / Z.ai',
    baseUrl: 'https://api.z.ai/api/anthropic',
    docs: 'https://docs.z.ai/scenario-example/develop-tools/claude',
    modelsUrl: 'https://api.z.ai/api/paas/v4/models',
    sourced: 'catalog-inferred',
    aliases: {
      opus: 'glm-5.3',
      sonnet: 'glm-5.3',
      haiku: 'glm-5.2',
      subagent: 'glm-5.2',
    },
    defaultModel: 'glm-5.3',
    contextTokens: 1048576,
    autoCompactWindow: 786432,
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    docs: 'https://platform.minimaxi.com/docs',
    modelsUrl: 'https://api.minimaxi.com/v1/models',
    sourced: 'catalog-inferred',
    aliases: {
      opus: 'minimax-m3',
      sonnet: 'minimax-m3',
      haiku: 'minimax-m2.7',
      subagent: 'minimax-m2.7',
    },
    defaultModel: 'minimax-m3',
    contextTokens: 1048576,
    autoCompactWindow: 786432,
  },
  {
    id: 'custom',
    label: 'Custom  (LiteLLM, llama.cpp, self-hosted gateway)',
    baseUrl: '',
    docs: 'https://code.claude.com/docs/en/llm-gateway-connect',
    sourced: 'user-supplied',
  },
]

export function findPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id)
}

/** China-mainland mirrors. Offered when the primary host is slow or blocked. */
export const MIRRORS: Record<string, string> = {
  kimi: 'https://api.moonshot.cn/anthropic',
  glm: 'https://open.bigmodel.cn/api/anthropic',
}

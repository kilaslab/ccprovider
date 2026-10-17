import { ProfileError } from './profile.js'
import { CREDENTIAL_VARS } from './launch.js'
import { shellQuote } from './shell.js'

export const ENV_FORMATS = ['sh', 'dotenv', 'json'] as const
export type EnvFormat = (typeof ENV_FORMATS)[number]

/** Set for a session on this machine; meaningless anywhere else. The formats meant for a
 *  container or an SDK leave it out. */
const HOST_ONLY = new Set(['CLAUDE_CONFIG_DIR'])

export function parseEnvFormat(value: string | undefined): EnvFormat {
  if (value === undefined) return 'sh'
  if ((ENV_FORMATS as readonly string[]).includes(value)) return value as EnvFormat
  throw new ProfileError(`Unknown --format "${value}". Choose one of: ${ENV_FORMATS.join(', ')}.`)
}

/** Variables whose value a dotenv parser other than `docker run --env-file` would change.
 *  That one reads a value as it stands. Compose's `env_file` and python-dotenv trim it, take
 *  off matching quotes, expand `$` and end it at ` #`. Names only: never the values. */
export function dotenvWarnings(env: Record<string, string>): string[] {
  return Object.entries(env)
    .filter(([k]) => !HOST_ONLY.has(k))
    .filter(([, v]) => v !== v.trim() || /^["']/.test(v) || v.includes(' #') || v.includes('$'))
    .map(([k]) => k)
}

/** Render a launch environment for `ccprovider env`.
 *
 *  - `sh`: `export` lines for `eval`. Single-quoted, see `shellQuote`.
 *  - `dotenv`: `KEY=value` with the value raw. `docker --env-file` takes everything after
 *    the first `=` literally, so quoting would put the quotes in the value.
 *  - `json`: one flat object, the shape of an Agent SDK's `env` option. */
export function formatEnv(env: Record<string, string>, format: EnvFormat): string {
  // `use` strips an inherited ANTHROPIC_API_KEY before launching; a file, an object or an
  // `eval` cannot strip anything the way it can, only set. Claude Code sends the key as
  // `x-api-key` alongside the token, to whatever ANTHROPIC_BASE_URL says, so an empty value is
  // how an Anthropic key left in the shell is kept away from the provider.
  const all = Object.entries(env)
  // Whatever of these the profile does not set. `use` deletes them from the environment it
  // builds, and a shell can do the same; a file or an object cannot delete anything, so it
  // carries an empty value, which was checked to leave routing as it should be.
  const stray = CREDENTIAL_VARS.filter((v) => !Object.hasOwn(env, v))

  if (format === 'sh') return all.map(([k, v]) => `export ${k}=${shellQuote(v)}\n`).join('') + stray.map((v) => `unset ${v}\n`).join('')
  for (const v of stray) all.push([v, ''])

  const portable = all.filter(([k]) => !HOST_ONLY.has(k))
  if (format === 'json') return `${JSON.stringify(Object.fromEntries(portable), null, 2)}\n`

  // A raw value cannot carry a line break: the rest of it would read as another variable,
  // and the value comes from a provider's model list, not from the user.
  const bad = portable.find(([, v]) => /[\r\n]/.test(v))
  if (bad) throw new ProfileError(`${bad[0]} contains a line break, which a dotenv file cannot hold. Use --format json.`)
  return portable.map(([k, v]) => `${k}=${v}\n`).join('')
}

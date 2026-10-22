import { getPaths, profileDir } from '../paths.js'
import { loadStore, getProfile, ProfileError } from '../profile.js'
import { configDirEnv, loadSettings, sessionConfigDir } from '../settings.js'
import { buildEnv, describeEnv } from '../launch.js'
import { detectStore } from '../secrets/index.js'
import { dotenvWarnings, formatEnv, type EnvFormat } from '../envformat.js'
import { isClaudeToken, isOauth } from '../types.js'
import { c } from '../ui.js'

export async function cmdEnv(
  paths: ReturnType<typeof getPaths>,
  secrets: Awaited<ReturnType<typeof detectStore>>,
  name: string,
  format: EnvFormat,
): Promise<number> {
  const store = loadStore(paths)
  const profile = getProfile(store, name)
  // The other formats are for something that is not this machine, and a subscription
  // profile has nothing to hand it: only a config dir, and that is left out.
  if (isOauth(profile) && format !== 'sh') {
    throw new ProfileError(`"${name}" is a Claude subscription profile: it has no provider variables to export. Its login lives in ${profileDir(paths, name)}.`)
  }
  const apiKey = isOauth(profile) ? '' : await secrets.get(name)
  if (apiKey === null || (!apiKey && !isOauth(profile))) { console.error(`No ${isClaudeToken(profile) ? 'setup-token' : 'API key'} stored for "${name}".`); return 1 }
  const dir = sessionConfigDir(paths, name, profile, loadSettings(paths))
  const env = buildEnv({ profile, configDir: configDirEnv(paths, dir, process.env), apiKey, model: null, baseEnv: {} })
  // Redacted when a human is looking; real values when piped into `eval` or a file.
  const shown = process.stdout.isTTY ? describeEnv(env) : env
  process.stdout.write(formatEnv(shown, format))
  if (format === 'dotenv') {
    const risky = dotenvWarnings(env)
    if (risky.length) {
      console.error(c.yellow(`! ${risky.join(', ')} ${risky.length === 1 ? 'has' : 'have'} a value that docker compose's env_file or python-dotenv would change (spaces at the ends, quotes, \`$\` or \` #\`).`))
      console.error(c.dim('  `docker run --env-file` reads them as they are. For anything else, use --format json.'))
    }
  }
  if (process.stdout.isTTY) {
    console.error(c.dim(`\n# token redacted for display; ${format === 'sh' ? 'pipe to `eval`' : 'pipe or redirect it'} for the real values`))
  }
  return 0
}

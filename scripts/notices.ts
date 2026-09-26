// Regenerate THIRD_PARTY_NOTICES.md from the runtime dependencies actually bundled into
// the binary:  bun run notices
//
// The release binaries embed these packages, and their licenses require the copyright and
// permission notices to travel with every copy. CI regenerates the file and fails if it
// differs, so adding or upgrading a dependency cannot leave the notices stale.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Pkg {
  name: string
  version: string
  license?: string
  repository?: string | { url?: string }
  dependencies?: Record<string, string>
}

const read = (name: string): Pkg => JSON.parse(readFileSync(join('node_modules', name, 'package.json'), 'utf8'))

// Runtime closure only: devDependencies (typescript, @types/*) never reach the binary.
const seen = new Set<string>()
const walk = (name: string) => {
  if (seen.has(name)) return
  seen.add(name)
  for (const dep of Object.keys(read(name).dependencies ?? {})) walk(dep)
}
for (const dep of Object.keys((JSON.parse(readFileSync('package.json', 'utf8')) as Pkg).dependencies ?? {})) walk(dep)

let out = `# Third-party notices

The ccprovider release binaries are produced by \`bun build --compile\`. Each one contains
the code of this repository, the npm packages listed below (bundled in), and the Bun
runtime. Their licenses require these notices to travel with the binary.

ccprovider's own code is under the [MIT License](LICENSE).

## Bun runtime

Every binary embeds the [Bun](https://bun.sh) runtime. Bun is MIT-licensed. It also
statically links JavaScriptCore and WebKit, which are **LGPL-2** licensed, and bundles
other libraries under MIT, Apache-2.0 and BSD-style licenses (and SQLite, which is in the
public domain). Bun's own statement on this is at <https://bun.sh/docs/project/licensing>,
and the source of its patched WebKit is at <https://github.com/oven-sh/webkit>.

LGPL-2 asks that someone who receives a binary with a statically linked library be able to
modify the library and relink. This project's answer is that it is open: this repository is
the complete source of everything except the runtime, and \`bun run build\` rebuilds the
binary from it against whichever Bun version you choose. If you redistribute these
binaries, the same notice applies to you.

## Bundled npm packages

`

for (const name of [...seen].sort()) {
  const pkg = read(name)
  const dir = join('node_modules', name)
  const file = readdirSync(dir).find((f) => /^licen[cs]e(\.md|\.txt)?$/i.test(f))
  if (!file) throw new Error(`${name} has no license file to include`)
  const repo = (typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? '')).replace(/^git\+/, '').replace(/\.git$/, '')
  out += `### ${pkg.name} ${pkg.version}\n\nLicense: ${pkg.license ?? 'see below'}${repo ? ` — ${repo}` : ''}\n\n\`\`\`text\n${readFileSync(join(dir, file), 'utf8').trim()}\n\`\`\`\n\n`
}

writeFileSync('THIRD_PARTY_NOTICES.md', out.trimEnd() + '\n')
console.log(`wrote THIRD_PARTY_NOTICES.md (${seen.size} packages)`)

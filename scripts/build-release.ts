// Cross-compile the release binaries and write their checksums:  bun run build:all
//
// Not part of the shipped program, so it is free to use whatever it likes. Every target
// builds from the one host: `bun build --compile --target=` fetches the matching Bun
// runtime, so no per-platform runner is needed.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TARGETS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'] as const
const out = 'dist'

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })

const sums: string[] = []
for (const target of TARGETS) {
  const file = `ccprovider-${target}`
  const r = spawnSync('bun', ['build', 'src/cli.ts', '--compile', `--target=bun-${target}`, '--outfile', join(out, file)], {
    stdio: 'inherit',
  })
  if (r.status !== 0) {
    console.error(`build failed for ${target}`)
    process.exit(1)
  }
  sums.push(`${createHash('sha256').update(readFileSync(join(out, file))).digest('hex')}  ${file}`)
}

// `sha256sum -c` / `shasum -a 256 -c` format, so install.sh and users verify with stock tools.
writeFileSync(join(out, 'SHA256SUMS'), sums.join('\n') + '\n')
console.log(`\n${sums.join('\n')}`)

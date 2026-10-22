import { homedir } from 'node:os'

import { ProfileError } from './profile.js'
import { blockHasDir, detectRcFile, pathBlockLines, upsertManagedBlock } from './shellrc.js'
import { binDirOnPath, inspectDefaultShim, type DefaultShimStatus } from './shim.js'
import { p } from './tui/prompts.js'
import { c, type Paths } from './ui.js'

/** Printed once after however many commands were installed: it is about the directory,
 *  not any one command. */
export function pathHint(paths: Paths): string[] {
  if (binDirOnPath(paths.binDir, process.env.PATH)) return []
  return [
    c.yellow(`  ${paths.binDir} is not on your PATH, so installed commands will not resolve yet.`),
    c.dim(`  bash/zsh: export PATH="${paths.binDir}:$PATH"   (add it to your shell profile — or run \`ccprovider init\`)`),
  ]
}

/** What is still between the user and the wrapper. Like `pathHint`, it is about a directory
 *  and not for one command, and it only ever prints: the thing that edits a shell profile is
 *  `ccprovider init`, which writes between its marker lines and only when asked. */
export function defaultPathHint(paths: Paths, s: DefaultShimStatus): string[] {
  if (s.dirOnPath && !s.shadowedBy) return []
  const why = s.shadowedBy
    ? `Typing \`claude\` still runs ${s.shadowedBy}.`
    : `${paths.defaultBinDir} is not on your PATH, so typing \`claude\` does not reach it yet.`
  return [
    c.yellow(`  ! ${why}`),
    c.dim(`    Put the directory before it:  export PATH="${paths.defaultBinDir}:$PATH"   (or run \`ccprovider init\`)`),
  ]
}

/** What the PATH block holds. The launchers directory is in it when it is off PATH, and also
 *  when this file's block already has it: the block is what put it on PATH, so deciding from
 *  PATH alone dropped it on every second run. */
export function blockLines(paths: Paths, file: string | null): string[] {
  const bin = !binDirOnPath(paths.binDir, process.env.PATH) || (file !== null && blockHasDir(file, paths.binDir))
  return pathBlockLines(paths.defaultBinDir, bin ? paths.binDir : null)
}

/** Write ccprovider's PATH block into `file`, between its marker lines, and say what happened. */
export function writeRcBlock(paths: Paths, file: string): void {
  let r: ReturnType<typeof upsertManagedBlock>
  try {
    r = upsertManagedBlock(file, blockLines(paths, file))
  } catch (e) {
    throw new ProfileError(`Could not update ${file}: ${(e as Error).message}`)
  }
  console.log(
    r === 'created' ? `${c.green('✓')} created ${file} with ccprovider's PATH block`
    : r === 'updated' ? `${c.green('✓')} updated ccprovider's PATH block in ${file}`
    : `${c.green('✓')} ${file} is already up to date`,
  )
  console.log(c.dim(`  Open a new shell, or run:  export PATH="${paths.defaultBinDir}:$PATH"`))
}

/** Offered where a person has just been told their shell cannot reach the wrapper: only at a
 *  terminal, only into an rc file of a shell this tool knows, always between marker lines. */
export async function offerRcWrite(paths: Paths, lines: string[]): Promise<void> {
  if (!lines.length || !process.stdin.isTTY) return
  const rc = detectRcFile(process.env, homedir())
  if (!rc) return
  const ok = await p.confirm({ message: `Add ccprovider's PATH block to ${rc.file} now?`, initialValue: false })
  if (p.isCancel(ok) || !ok) return
  writeRcBlock(paths, rc.file)
}

/** Say whether the default `claude` will be found on this shell's PATH, and offer to fix that. */
export async function offerDefaultPath(paths: Paths): Promise<void> {
  const hint = defaultPathHint(paths, inspectDefaultShim(paths))
  for (const line of hint) console.log(line)
  await offerRcWrite(paths, hint)
}

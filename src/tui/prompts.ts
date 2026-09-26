import * as p from '@clack/prompts'

/** Every prompt can be cancelled with Ctrl-C. Centralised so no call site forgets. */
//
// Typed as `Exclude<T, symbol>` rather than `T | symbol -> T`: @clack/prompts 1.8 made its
// cancel marker a `unique symbol`, which the older signature no longer narrowed away, so a
// fresh `npm install` (which ignores bun.lock and takes the newest 1.x) failed to compile.
// This form is right for the old and the new typing alike.
export function orCancel<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) {
    p.cancel('Cancelled — nothing was saved.')
    process.exit(130)
  }
  return value as Exclude<T, symbol>
}

export { p }

import * as p from '@clack/prompts'

/** Every prompt can be cancelled with Ctrl-C. Centralised so no call site forgets. */
export function orCancel<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Cancelled — nothing was saved.')
    process.exit(130)
  }
  return value as T
}

export { p }

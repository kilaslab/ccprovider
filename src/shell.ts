/**
 * POSIX single-quote a value for shell output.
 *
 * `ccprovider env` is documented as `eval "$(ccprovider env <name>)"`, so its output is
 * executed. Double quotes (what JSON.stringify emits) still expand `$(…)`, backticks and
 * `$VAR`, which makes any value that reaches this function a code-execution vector — and
 * model IDs are not self-supplied: they come from whatever host the profile points at,
 * via the provider's model-list endpoint. Single quotes suppress every expansion; the
 * only character needing care is the single quote itself.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

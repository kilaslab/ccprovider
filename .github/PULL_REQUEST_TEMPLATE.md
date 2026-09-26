<!--
One change per pull request. Keep this description short but make it specific —
a reviewer holding the diff has no use for a restatement of it.
-->

## What this changes

## Why

<!--
The reasoning the diff cannot carry: what the alternative was, why this one won,
and what would break if someone changed it back.
-->

## How it was verified

<!-- The exact commands and what you observed. "Tests pass" is not a verification. -->

## Checklist

- [ ] `bun test` and `bun run typecheck` pass locally.
- [ ] Behaviour that changed has a test, and a bug fix has a `// Regression:` test that fails without it.
- [ ] `README.md` and the `USAGE` text in `src/cli.ts` still describe the commands that exist.
- [ ] If a provider preset changed: its base URL was probed with a control path, and `sourced` says where the model IDs came from (see CONTRIBUTING).
- [ ] If this touches a trust boundary — the API key, the launcher files in `binDir`, MCP provisioning, or `removeProfileDir` — the description says what the threat model assumes.

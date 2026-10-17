# The token footer

```bash
ccprovider statusline          # is it installed?
ccprovider statusline add      # install it, or update it
ccprovider statusline rm       # take it off again
```

`ccprovider add` offers it once, with the default answer Yes. It puts a badge in Claude Code's
footer such as `[ctx 21k/1M 2%]`: how much of the context window is in use.

The badge is [cc-token-statusline](https://github.com/Alfafis/cc-token-statusline) by Alfafis
(MIT). ccprovider does not carry a copy of it. It pins one upstream commit with a sha256 for
every file, downloads those files once, checks each hash, and runs the installer upstream
ships. If the Claude plugin of the same name is installed and its files are exactly the pinned
ones, that copy is used and nothing is downloaded. A file that does not match is refused, and
nothing of the download is kept.

## One install covers every profile

`statusLine` lives in `settings.json`, which every profile links to, so installing once is
enough, and `glm`, `kimi` and a plain `claude` all show it. The installer is pointed at your
real config directory (`~/.claude`) and not at the profile it happens to be run from: a
profile's path written into the shared file would break the footer of every other profile the
day that one is deleted.

- The badge is copied to `~/.claude/hooks/`. Each profile keeps its own running totals in its
  own `statusline-cache/`.
- `settings.json` is backed up first (`settings.json.bak.<time>`).
- A status line you already have is **wrapped**, not replaced: yours runs first and the badge is
  appended to its output. `ccprovider statusline rm` puts yours back.
- `ccprovider doctor` reports it. A footer whose script has gone missing is a failure, because
  a status line command that fails shows nothing at all, other badges included.
- **Run it with `ccprovider statusline add`, not the plugin's own installer, from a profile.**
  The plugin's session nudge tells Claude to run its installer in the session's config directory,
  which in a profile's session is the profile's. `settings.json` is shared, so every profile's
  footer then depends on that one profile's directory: remove the profile and the status bar goes
  everywhere. `doctor` and `statusline` flag it, `rm` warns before deleting that profile, and
  `statusline add` moves the footer into the real config directory.
- A status line script of your own that already calls the badge is recognised as the footer
  (the way the installer itself recognises it), so it is not offered again, and `add` only
  refreshes the badge's copy and leaves your `statusLine` as it is.
- The command is read the way a shell reads it: double or single quotes, `~`, `$VAR`, `${VAR}`
  and `${VAR:-default}`. The chain wrapper counts as working only while the badge it appends is
  there too.
- A command that finds the script through `$CLAUDE_CONFIG_DIR` is judged against that variable
  as it is set where you run `doctor`, not made up. In a profile's session it is the profile's
  directory, which has no `hooks/`; `ccprovider statusline add` rewrites such a command to the
  absolute path.
- The offer is made once. A "no", and also `ccprovider statusline rm`, is remembered, so `add`
  does not ask again; cancelling the prompt with Ctrl-C is not an answer and is not
  remembered. A footer that has stopped working is raised again whatever was answered.
- A newer badge than the one ccprovider pins (the Claude plugin's own hook can install one) is
  left as it is: `statusline add` does not downgrade it, and `doctor` does not call it stale.
- It needs python 3.8 or newer that runs. On a Mac without the Command Line Tools
  `/usr/bin/python3` is only a stub, and ccprovider says so rather than hanging on it.
- The files are needed once, from GitHub or from the Claude plugin. Offline, `statusline rm`
  tells you how to take the key out of `settings.json` by hand.

## On a provider that is not Anthropic

Measured on a real GLM session (Claude Code 2.1.302, the payload it hands the status line):

| Segment | On by default | What you get on GLM |
|---|---|---|
| `ctx`: context use | yes | **Correct.** The window size follows `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, which ccprovider sets from the profile, so a 1M model reads `…/1M` ([why](../README.md#why-not-just-export-the-variables-yourself)). |
| `quota`: 5 h / 7 d limits | yes | **Empty.** Claude Code sends `rate_limits: null` unless you are signed in with a Claude subscription. |
| `tok`: tokens spent | no | **Too high, 2 to 3 times.** One session had 487 requests and the badge counted 1,027; input 1.29M against 482K, output 548K against 179K. |
| `cache`: hit rate | no | About right (99.2% against 99.4%), because the ratio survives the double counting. |
| `cost` | no | **Not a price you pay.** Claude Code prices unknown models itself (`$0.11` for a session on a flat plan). |
| `sub`: subagent spend | no | **Blank.** Subagents write their own transcript files, which the badge never reads. |

The reason for the token figures: the badge counts each request once, keyed by `requestId`,
then `uuid`. Claude Code writes one API call as several transcript lines, and a provider such
as GLM sends no `requestId`, so every line has its own `uuid` and every line is counted.

So ccprovider leaves the badge on its defaults, which are the two that are right or silent. For
tokens and cache per model, use [`ccprovider usage`](usage.md), which counts by message id and
includes subagents. The segments can be chosen with `CC_TOKENS_SEGMENTS` (see the upstream
README); turn on `tok`, `cost` or `sub` knowing the above.

## Plan quota is not in the footer

A flat-rate plan has its own limits, and the provider keeps the figures; Claude Code does not
pass them on. What exists today, from the providers' own pages:

- **GLM Coding Plan** limits apply per 5 hours and per week
  ([FAQ](https://docs.z.ai/devpack/faq)). Z.ai's official plugin
  ([`glm-plan-usage`](https://docs.z.ai/devpack/extension/usage-query-plugin)) reads them from
  `/api/monitor/usage/quota/limit` on the provider's host, sending the API token in the
  `Authorization` header. Tried with a real key, the endpoint answers with a `limits` list of
  two windows with a percentage used and a reset time. Its field names differ from what the
  plugin's script still maps, so treat the shape as unstable.
- **Kimi Code** documents the console for remaining quota and no API
  ([membership](https://www.kimi.com/code/docs/en/kimi-code/membership.html)). Its benefits
  page also restricts automated use of the key, so check it before scripting against it.
- **MiniMax** community tools call `GET /v1/api/openplatform/coding_plan/remains`; the host and
  fields differ between sources and there is no first-party reference to confirm them.

None of this is wired into ccprovider.

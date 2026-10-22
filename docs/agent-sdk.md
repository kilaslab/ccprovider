# Using the Claude Agent SDK, or Docker, with another provider

The Claude Agent SDK (TypeScript and Python) runs Claude Code as a subprocess, and Claude
Code takes its provider from environment variables. So pointing the SDK at GLM, DeepSeek,
Kimi or any other profile is a matter of handing that subprocess the variables ccprovider
would have set for you.

```bash
ccprovider env glm --format json      # an object for the SDK's env option
ccprovider env glm --format dotenv    # KEY=value lines for docker run --env-file
```

## Why the environment, and nothing else

- **Not `settings.json`.** Writing the provider into `~/.claude/settings.json` points every
  profile at it, because they all link to that file and its `env` wins
  (see [the warning about `coding-helper`](../README.md#glm-mcp-tools)). A container has no
  `~/.claude` to write to anyway.
- **Not the `claude` command.** The SDK starts its own copy of Claude Code, so a wrapper on
  your `PATH` never sees it.
- **Not ccprovider inside the container.** It needs a keychain or a vault; the container has
  neither. Export on the machine that has the profile and pass the values in.

## What you get

The same variables `glm` would launch with: the base URL and token, `ANTHROPIC_MODEL`, the
opus, sonnet, haiku and subagent mappings, and the context-window settings (see
[Why not just export the variables yourself](../README.md#why-not-just-export-the-variables-yourself)
for why each one is there).

Two are deliberate:

- **`CLAUDE_CONFIG_DIR` is left out.** It is a path on this machine, meaningless in a
  container. The SDK then keeps its session history wherever its own environment points:
  `CLAUDE_CONFIG_DIR` if your shell has one set (a shell started by another profile does),
  otherwise `~/.claude`. To keep SDK runs in this profile's history, and so in
  [`ccprovider usage`](usage.md), set `CLAUDE_CONFIG_DIR` to the profile's directory
  yourself (`ccprovider env glm` prints it).
- **The credentials and routing flags are emptied.** Claude Code sends `ANTHROPIC_API_KEY` as an
  `x-api-key` header next to the token, and `ANTHROPIC_CUSTOM_HEADERS` as headers, to whatever
  `ANTHROPIC_BASE_URL` says. Measured against a local stand-in for a provider: with those
  left in the environment both reached it, and `CLAUDE_CODE_USE_BEDROCK` kept any request from
  reaching it at all. Emptied, none of that happened and routing was normal. So the export
  covers `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_CUSTOM_HEADERS`,
  `ANTHROPIC_BEDROCK_BASE_URL`, `ANTHROPIC_VERTEX_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK` and
  `CLAUDE_CODE_USE_VERTEX`: the credentials and routing flags among what `ccprovider use`
  deletes from a launch. The model and endpoint variables it also clears (an inherited
  `ANTHROPIC_DEFAULT_HAIKU_MODEL` the profile does not map, say) are removed by the `sh` form
  only, which prints `unset` for each of them; a file or an object cannot delete anything, so
  pass those over a clean environment if you rely on that. For the credentials and routing flags
  the `sh` form prints `unset` too, and a file or an object carries an empty value.

On a terminal the token is redacted. Piped or redirected, the output holds your real API key,
so treat it like one.

## TypeScript

```ts
import { execFileSync } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'

// The provider's variables, from the profile you made with `ccprovider add`.
const providerEnv = JSON.parse(execFileSync('ccprovider', ['env', 'glm', '--format', 'json'], { encoding: 'utf8' }))

for await (const message of query({
  prompt: 'Reply with the single word: ok',
  options: {
    // TypeScript: `env` replaces the subprocess environment, so spread process.env.
    env: { ...process.env, ...providerEnv },
    // An alias, not a Claude model ID: the profile maps it to the provider's model.
    model: 'sonnet',
    // See "What the SDK picks up from ~/.claude" below.
    settingSources: [],
    maxTurns: 1,
  },
})) {
  if (message.type === 'result') {
    console.log('result:', message.result)
    console.log('models:', Object.keys(message.modelUsage)) // [ 'glm-5.3-flash' ]
  }
}
```

## Python

```python
import asyncio
import json
import subprocess

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

provider_env = json.loads(
    subprocess.run(
        ["ccprovider", "env", "glm", "--format", "json"],
        check=True, capture_output=True, text=True,
    ).stdout
)


async def main():
    options = ClaudeAgentOptions(
        # Python: these values are merged over the environment you already have.
        env=provider_env,
        model="sonnet",
        setting_sources=[],
        max_turns=1,
    )
    async for message in query(prompt="Reply with the single word: ok", options=options):
        if isinstance(message, ResultMessage):
            print("result:", message.result)
            print("models:", list((message.model_usage or {}).keys()))


asyncio.run(main())
```

The two languages differ on `env`: in TypeScript it **replaces** the subprocess environment,
in Python it is **merged over** it. Spread `process.env` in TypeScript.

## Inside Docker

```bash
docker run --rm --env-file <(ccprovider env glm --format dotenv) my-agent-image
```

`<( … )` hands Docker a pipe, so the key never lands in a file. `docker run --env-file` reads
each value literally, which is what the `dotenv` format assumes: no quoting, no `export`.
Inside the container nothing needs an `env` option, because the variables are already in the
environment the SDK inherits.

The Python package ships its own copy of Claude Code, so a bare `python:3.12-slim` plus
`pip install claude-agent-sdk` is a complete image. That is the one this was tried on, with
the Python example above and no `env=` argument.

**Compose reads `env_file` differently.** It expands `$` and treats ` #` as a comment, which
`docker run --env-file` does not. Measured: `a$b$c` arrives as `a`, and `x #y` as `x`. Other
dotenv parsers such as python-dotenv also trim spaces and take off matching quotes. API keys
usually have none of these, so `env_file: glm.env` is fine for most. When a value does,
`ccprovider env --format dotenv` says which variable on stderr (never the value), and you
should use `docker run`, `--format json`, or pass the variables from your shell with
`environment:` entries that name a variable without a value.

Keep the key out of the image: no `ENV`, no `ARG`, and do not commit a `.env` you exported to
a file.

## Which model answers

`model: 'sonnet'` resolves through the profile, so it lands on the model you mapped to the
sonnet tier. `result.modelUsage` lists what actually ran. Leave `model` out and the SDK uses
`ANTHROPIC_MODEL` from the export: the profile's start model, which may be `opusplan`.

A literal Claude model ID depends on the provider. Z.ai answered `claude-sonnet-4-5` in a test
here, but its reply names the model *you asked for*, so nothing on the client side says which
GLM model ran. Other providers refuse an ID they have not heard of. Use the aliases.

## What the SDK picks up from `~/.claude`

Like the CLI, the SDK loads your Claude Code configuration unless you tell it not to.
Measured on this machine, a default session started with 15 plugins, 129 skills and 2 MCP
servers; with `settingSources: []` (`setting_sources=[]` in Python) it started with 3, 18 and
0. Everything loaded is part of what the provider receives, plugin hooks run, and in one test
run the model repeated a notice a plugin's session hook had injected.

For a server or a CI job, pass `settingSources: []`. The cost is that `CLAUDE.md` and project
settings are skipped as well; add `'project'` back if you want the project's.

## Running somewhere else

Export on the machine that has the profile, and put the values in the secret store of
wherever the job runs. ccprovider is not needed there. Copying `providers.json` does not help:
it never holds a key.

## When it does not work

| You see | It means |
|---|---|
| `Not logged in · Please run /login` | No provider variables reached Claude Code. Check that the export is not empty: `ccprovider env glm --format dotenv \| wc -l`. An older ccprovider that does not know `--format` fails here. |
| `[claude-code:unrecognized_model] {"model":"glm-5.3-flash", …}` on stderr | A notice, not a failure. Claude Code does not recognise third-party model IDs; the context-window variables in the export cover the consequence. |
| `claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set` | Expected. You are using a token, not a claude.ai login. |
| 401 from the provider | The key is wrong or expired. `ccprovider doctor glm` sends a real request. |
| It talks to the wrong provider | A `settings.json` with an `ANTHROPIC_*` block is being loaded and wins over what you passed. Use `settingSources: []`. `ccprovider doctor` flags such a file. |

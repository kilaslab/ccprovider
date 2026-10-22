# Making a profile your default `claude`

Every profile is already a command: `glm` launches Claude Code on GLM. Sometimes you want
the plain `claude` to do that instead, on a machine that only ever uses one provider, say.

```bash
ccprovider default glm       # `claude` now runs the glm profile
ccprovider default           # which profile is it?
ccprovider default --off     # put the real claude back
```

Or skip the extra profile: `ccprovider add --default` makes one profile called `default`, replaced
in place each time you pick another provider, and `ccprovider default --use deepseek` swaps back
to one it kept. See [One profile called `default`](#one-profile-called-default-replaced-in-place).

## What it does

`ccprovider default glm` writes a small script called `claude` into
`~/.local/share/ccprovider/bin/`. It does what the `glm` command does: it runs
`ccprovider use glm -- <your arguments>`, and that starts the real Claude Code with the
profile's environment. Everything you type after `claude` (`--resume`, `-p`, `--model`)
goes through untouched.

It does **not** touch `~/.local/bin/claude`. That is Claude Code's own symlink, and its
updater rewrites it, so anything placed there would quietly disappear on the next update.
The script lives in a directory of its own instead, and works once that directory comes
before Claude Code's on your `PATH`.

It also never writes your provider into `~/.claude/settings.json`. That file is shared by
every profile and its `env` wins over what a profile sets, so one provider written there
would take over all of them (see [the warning about `coding-helper`](../README.md#glm-mcp-tools)).

## Set it up

1. Make sure the profile exists (`ccprovider add`), and that its own command works.
2. Run `ccprovider default <profile>`. It prints the line to add to your `PATH` if the new
   directory is not in front yet:

   ```bash
   export PATH="$HOME/.local/share/ccprovider/bin:$PATH"
   ```

   At a terminal it offers to add that line for you. Say yes and it writes it into your
   `~/.zshrc` (zsh) or bash's startup file (`~/.bashrc`; on macOS, where Terminal and iTerm
   start login shells, the first of `~/.bash_profile`, `~/.bash_login` and `~/.profile` that
   exists), between marker lines:

   ```bash
   # >>> ccprovider path >>>
   export PATH="$HOME/.local/share/ccprovider/bin:$PATH"
   # <<< ccprovider path <<<
   ```

   `ccprovider init` writes the same block any time, and replaces its own block on re-run
   instead of adding a second one. Everything around the markers is yours and is never
   touched. Any other shell, or a file you would rather edit yourself: add the line by hand.
3. Open a new shell and check:

   ```bash
   type -a claude        # the first line is ~/.local/share/ccprovider/bin/claude
   ccprovider doctor     # "default command `claude`  runs "glm""
   ```

Any profile can be the default, including a Claude subscription one. Running
`ccprovider default <other>` again switches it.

## One profile called `default`, replaced in place

`ccprovider default <name>` points `claude` at a profile you made with `add`, so every provider
you try is one more profile. If you only ever want one provider at a time, do this instead:

```bash
ccprovider add --default      # pick a provider; it is written as the profile "default"
```

It skips the name question, writes a single profile called `default`, and makes `claude` run it.
Pick another provider later and that profile is **overwritten**, not added to. It works for every
provider, a Claude subscription (`/login`) and a setup-token one included, and `claude` needs no
`PATH` change the second time: the script is already in place. The name `default` is reserved for
this, so `add` and `rename` will not hand it out to an ordinary profile. (A profile called
`default` from before the rule keeps working as it is.)

What it replaces is **kept, not deleted**. The old profile and its key (or setup-token) are filed
under the provider they were — `deepseek`, `claude-token`, `claude` for a `/login`, and so on — in
`~/.config/ccprovider/slot.json` and your keychain under `default:<provider>`. They are not
profiles, so `ccprovider ls` shows them only as a line under `default`:

```
default        ready
  https://api.deepseek.com/anthropic
  command claude  (the default)
  stashed: claude-token  — `ccprovider default --use <name>`
```

Swap back with no wizard and no key typed:

```bash
ccprovider default --use claude-token    # the subscription is back; deepseek is kept
ccprovider default --use deepseek        # and the other way
ccprovider default --forget deepseek     # drop one, and its key
```

One is kept per provider, so a second `custom` gateway replaces the first. `ccprovider rm default`
removes the profile, everything it stashed and their keys. `ccprovider doctor` checks each kept
key is still in the keychain.

### Carrying a session across

The directory of `default` stays the same through every swap, so its session history does too. The
case this is for: a Claude subscription runs out in the middle of work.

```bash
ccprovider default --use deepseek
claude --continue                        # the last session in this folder, now on DeepSeek
```

`--use` says so when it will not work: if the two providers differ in sharing (one shares
`~/.claude`, the other has its own directory), their sessions are in different places and
`claude --continue` will not find the other's. Give both the same choice in `ccprovider settings`.

Not tested end to end: whether a provider accepts a transcript written by a different model's
thinking blocks. If a resumed session errors, start a new one in the same folder.

A `/login` is set aside (`.credentials.stashed.json` in the profile's directory) when the default
stops being that subscription, and put back when you swap to it, so you do not sign in again.
On macOS the login itself lives in the Keychain and is not touched.

### Without the wizard

For a script or a machine with no terminal, the answers come from flags and the key from standard
input; nothing is asked:

```bash
printf '%s' "$KEY" | ccprovider add --provider deepseek --key-stdin --default -y
```

`-y` is required to replace an existing default. The full list of flags is in
`ccprovider --help`. A check of the endpoint and every model runs first and a failure exits
non-zero; `--no-probe` skips it.

## A `claude` inside a session

A session that `ccprovider use` starts is marked (`CCPROVIDER_SESSION=1`). The script knows
it was called as the default (it passes `--from-default`), and when it finds that mark it does
not move anything: it runs the real Claude Code with the environment it already has. So a
`claude` run from inside a session, by a hook or by a subagent's shell, stays on that
session's provider and does not get pulled onto the default profile with another bill. A
`glm` session stays on GLM all the way down, even when another profile is the default.

Nothing about `PATH` is changed to make this work, so the other tools in the script's
directory are still there, and `ccprovider doctor` or `ccprovider default` run from inside a
session judge your `PATH` as it really is. The mark is inherited by anything started from
inside the session (a tmux server, a dev server): a `claude` typed there is also passed
through, and at a terminal the script says so (nothing is printed to a hook or a subagent). For
the default profile, open a terminal that was not started from a session.

The script is also recognised by what it is and not only by which directory it is in. If you
move `CCPROVIDER_DEFAULT_BIN_DIR` or `XDG_DATA_HOME` after running `ccprovider default`, the
script left at the old place is still skipped when ccprovider looks for the real `claude`.

## Where its sessions live

The default `claude` uses the profile's own directory
(`~/.local/share/ccprovider/dirs/<profile>/`), exactly as `glm` does. Skills, plugins, rules,
agents, commands, `CLAUDE.md` and `settings.json` are shared from `~/.claude`; history and the
login are the profile's own (see
[Profiles are isolated but not duplicated](../README.md#profiles-are-isolated-but-not-duplicated)).
For the `default` profile this directory is kept when you change provider with
`ccprovider add --default` or `default --use`, so its sessions carry over.

So sessions you had in `~/.claude` before do not show up in `claude --resume`; they are still
there, and calling the real binary by its path (`~/.local/bin/claude`) reads them again.
If you want the opposite — one directory of sessions for every profile and the plain
`claude` — see `ccprovider settings set shareSessions` in
[the README](../README.md#profiles-are-isolated-but-not-duplicated).

## Getting the real Claude back

- `ccprovider default --off` removes the script. `claude` is Claude Code as installed again.
- To keep the override but still reach Anthropic's models, make a **Claude subscription**
  profile in `ccprovider add` (it gets its own login) and use its command, `pclaude` for
  example, or make that the default. With `add --default`, pick "Claude subscription" or
  "Claude subscription (setup-token)", or `ccprovider default --use claude-token` if you had it.
- The real binary is still where it was. Calling it by path skips the script.

## Renaming and deleting the profile

- `ccprovider rename glm zai` points the script at `zai`.
- `ccprovider rm glm` removes the script too, so `claude` is not left launching a profile
  that is gone. `rm default` also removes everything the default stashed.
- The `default` profile cannot be renamed once it has stashed providers.
- `doctor` reports a script whose profile no longer exists as a failure.

## A server or a mini PC

On a machine you reach over SSH, or run from cron or systemd, `claude` is started by a shell
that is **not interactive**, and it does not read the file you added the `PATH` line to
(`ccprovider init` only writes the interactive ones: `~/.zshrc`, and bash's `~/.bashrc` or, on macOS, `~/.bash_profile`).
Measured: a non-interactive `zsh -c` ignores `~/.zshrc` and reads `~/.zshenv`; a
non-interactive `bash -c` ignores `~/.bashrc`, and a login `bash` reads `~/.profile`.

| Shell | Put the `PATH` line in |
|---|---|
| zsh | `~/.zshenv` |
| bash | `~/.profile`, and the top of `~/.bashrc` (above any "if not running interactively, return") |

Then check the way the job will see it:

```bash
ssh mini-pc 'command -v claude'     # should print .../ccprovider/bin/claude
```

With no keyring on a headless Linux box, ccprovider keeps the key in an encrypted file
instead; `ccprovider doctor` names the backend in use (see
[Where things live](../README.md#where-things-live)).

## What it does not reach

- **IDE extensions and the desktop app** start their own Claude Code and never look `claude`
  up on your `PATH`.
- **The Agent SDK** does the same. Give it the profile's variables instead:
  [docs/agent-sdk.md](agent-sdk.md).

## When it does not work

`ccprovider doctor` checks all of this under "default command".

| You see | It means |
|---|---|
| `installed, but … is not on PATH, so claude runs …` | The directory is not on `PATH` in this shell. `ccprovider init` adds the line (zsh and bash); on a server, see the table below. |
| `installed, but claude resolves to … first` | Another `claude` comes earlier on `PATH`. Put the ccprovider directory before it — `ccprovider init` does it (zsh and bash). |
| `points at …, which is missing or not executable` | The script remembers where ccprovider and Node were when you made it. After a Node version change or a move, run `ccprovider default <profile>` again. |
| `runs profile "x", which no longer exists` | The profile was removed some other way. `ccprovider default --off`, or pick another profile. |
| `… is not a ccprovider wrapper` | A different file named `claude` is in that directory. ccprovider leaves it alone; move it aside and run `ccprovider default <profile>` again. |
| `Could not find claude on your PATH. Install Claude Code first` | The script found no real Claude Code behind it. It skips its own directory on purpose, so install Claude Code or fix its `PATH` entry. |

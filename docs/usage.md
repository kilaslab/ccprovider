# See what each profile spends

```bash
ccprovider usage              # every profile
ccprovider usage glm          # one
ccprovider usage glm --since 7d --by day
ccprovider usage --json       # exact figures, for scripts
```

It reads the transcripts Claude Code already keeps in each profile's directory. Nothing sits
in the request path and nothing extra is recorded while you work.

```
glm
  model          calls   input  output  cache read  cache write  cache hit
  glm-5.2           25   49.9K    6.2K           —            —          —
  glm-5.3          115  229.7K   55.3K        4.1M            0        95%
  glm-5.3-flash    460  736.1K  119.7K       10.7M            0        94%
  total            600    1.0M  181.2K       14.8M            0        94%

work  Claude subscription
  model             calls  input  output  cache read  cache write  cache hit
  claude-haiku-5-5    230   4.8K   39.1K        2.9M       240.9K        92%
  claude-opus-5-5     115   2.2K  135.6K        6.5M       515.9K        93%
  total               345   7.0K  174.7K        9.4M       756.8K        92%
```

(Example figures.)

## Reading it

| Column | Meaning |
|---|---|
| `calls` | API calls the model answered, subagents included |
| `input` | input tokens that were **not** served from cache |
| `output` | tokens the model wrote |
| `cache read` | input tokens served from the prompt cache |
| `cache write` | input tokens written into the cache |
| `cache hit` | cache read ÷ (input + cache read + cache write) |

A dash means the provider did not report cache at all (`glm-5.2` above), which is not the
same as a 0% hit rate. The `total` row's hit rate leaves such models out, for the same reason.

Figures are rounded for reading (`1.3M`). `--json` has the exact ones:

```json
{
  "rows": [
    { "profile": "glm", "model": "glm-5.3", "calls": 115, "input": 229740, "output": 55264,
      "cacheRead": 4130186, "cacheWrite": 0, "cacheReported": true }
  ],
  "unreadableLines": 0,
  "skippedFiles": 0
}
```

## Choosing a period

- `--since 7d` counts calls from the last seven days; `--since 2026-10-01` from that day,
  local midnight.
- `--by day` gives one row per model per day, in your local time zone.

## A default that changed provider

`ccprovider add --default` and `default --use` keep the default's directory, so its transcripts
go on across a change of provider. The default records when it changed (`slot.json`, beside the
profile config), and each call is counted under the provider it went to, by the time it was
made:

```
default  GLM / Z.ai
  model              calls  input  output  cache read  cache write  cache hit
  glm-5.3               115  229.7K   55.3K        4.1M            0        95%

default  Claude subscription
  model              calls  input  output  cache read  cache write  cache hit
  claude-opus-5-5        42   88.1K   12.0K        1.2M            0        93%
```

This does not go by the model's name, which is why a GLM call that was answered as
`claude-sonnet-4-5` (below) stays under GLM. A provider it came back to is one group. With one
provider all along it prints like any other profile. A default from before the record existed has
no times to go by; its rows are split by the model's name as a fallback, which has that same
hole. `--json` adds `era` to each row.

## How a call is counted

Counting transcript lines would be wrong twice over.

- **One call is written as several lines**, snapshots of the same message. On a real GLM
  profile, 2,700 assistant lines were 1,250 calls, and the early snapshots read 0 input and 0
  output. On Anthropic's models `output_tokens` grows from line to line. So lines are grouped
  by message id and the largest figure of each kind is kept.
- **Subagents write their own transcripts**, deeper in the tree, and on one profile they were
  most of the calls. They are included.

## Where the numbers are kept

`ccprovider usage` remembers how far into each transcript it has read, in
`~/.local/share/ccprovider/usage/<profile>.json` (in a directory only you can enter, and readable only by you). The first run reads
everything; after that it reads only what was added. On the machine this was written on, a
3.3 GB profile took about 8 seconds the first time and 0.1 seconds after.

That file is **data, not a cache**. Claude Code deletes session transcripts after
`cleanupPeriodDays` (30 by default), but the ledger keeps what it already counted, so your
totals do not shrink when the transcripts go.

- `--rebuild` forgets the ledger and counts again from the transcripts that still exist,
  which is what you want if you suspect it is wrong. It also drops anything Claude Code has
  deleted since, so the ledger it replaces is kept as `<name>.json.bak`. A second rebuild
  does not copy the already-shrunk ledger over it: the copy that holds more calls stays. To
  undo a rebuild, put that file back.
- A ledger from a **newer ccprovider** (a version this one does not know) is not touched at all:
  not copied, not replaced, not saved to. That run reports from the transcripts that still
  exist and says so; update ccprovider to read the ledger.
- A ledger that cannot be read is never written over, whether it is damaged, was written by a
  newer ccprovider, or holds an entry that makes no sense. It is kept as `<name>.json.damaged`
  and the profile is read afresh from its transcripts; the unreadable file is replaced by an
  empty ledger once the copy is safe, so this happens once and not on every run. A name that
  was used is never reused: the next one is `.damaged.2`, then `.damaged.3`.
- `rename` moves a profile's ledger and every file above with it, and `rm` deletes all of them.
- A profile with `shareSessions` on runs in `~/.claude` itself, so its report gains a
  **`shared`** group: everything that ran in that directory — the profiles that share it and
  the plain `claude` alike. Transcripts never name a profile, so nothing finer is possible,
  and the trees are disjoint (the profile's older sessions stay in its own directory), so
  nothing is counted twice. That group's ledger lives at
  `~/.local/share/ccprovider/usage/shared/<hash>.json`, keyed by the directory, and `rename`
  and `rm` leave it alone while any profile may still share the directory.
- A transcript is read on from where the ledger stopped only while it is still the same file:
  the stored position must sit on a line break and its first line must be the one it began
  with. A transcript written over (compacted, rewound) is read again from its start, which is
  safe because a call counts once whatever number of times it is seen.
- It holds message ids, model names, times and counts. No prompt, reply or file content. Its
  keys include the transcript paths relative to the profile, which carry your project
  directory names.

## What it does not tell you

- **Not the provider's bill.** These are counts from the transcripts on this machine. There
  is no cost column because ccprovider has no price list for every provider, and a made-up
  figure would be worse than none. Compare with the provider's own dashboard before you rely
  on a number for money.
- **A call is told apart from another by the message id the provider gave it.** Anthropic and
  GLM give every call its own, which was checked on real transcripts. A provider or proxy that
  answers with the same id every time would have all its calls counted as one, with the largest
  figures kept, and nothing would say so. If your provider's `calls` look far too low, that is
  the first thing to check.
- **The model is the name the provider reported.** Z.ai answers a request for
  `claude-sonnet-4-5` and names that same model in its reply, so such a call shows up under
  that name even though a GLM model answered it. Sessions started through a profile use the
  profile's mapped names, and those are the ones you will mostly see.
- **Runs elsewhere are not here.** A container or an Agent SDK run writes its transcripts
  where it runs. SDK runs on this machine land in the profile only when `CLAUDE_CONFIG_DIR`
  points at it ([docs/agent-sdk.md](agent-sdk.md)).
- **`~/.claude` itself is not counted** for an ordinary profile, only the profiles'
  directories. A profile with `shareSessions` on is the exception: what ran in `~/.claude`
  shows up under its `shared` group, above. A Claude subscription profile (see
  `ccprovider add`) is the way to count your Anthropic use.
- A transcript written after the last read is counted the next time you run it. A line still
  being written is left for then, so a call is never half counted.
- A line that looks like a call and cannot be used (cut off, or with no id or an absurdly long
  one) is a call missing from the totals. It is counted and reported every time, in
  `unreadableLines` of `--json` too, not only on the run that met it. Providers spell their
  message ids as they like; any id is filed as it is.
- A transcript is resumed only if it is still the file that was read: the position must be a line
  break, the first line must be the same, and so must the last 256 bytes before the position. A
  file rewound and grown past its old size is therefore read again. One rewritten to exactly the
  byte length it had, with the same beginning and the same bytes there, is not noticed;
  `--rebuild` counts it again.
- The ledger is written whole at the end of a pass and every 128 MiB read during one. For the
  profiles tried here (a few megabytes of ledger for a few gigabytes of transcripts) that is
  cheap; a profile with millions of calls would feel it.
- A transcript that cannot be opened (Claude Code deleted it, or its permissions changed,
  while the pass ran) costs only itself: it is reported as `skippedFiles` and read next time.

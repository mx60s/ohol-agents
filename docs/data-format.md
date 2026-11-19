# Data format: what the always-on run writes, for later analysis

Everything lives on the Fly volume (`/data`, app `artificial-selection`) and is
copied off-site every 3 hours by `deploy/backup-logs.sh` (see `deploy/README.md`,
"Log backups"). Nothing is deleted on purpose: rotated files keep their names
forever, and the size cap (`LOG_MAX_TOTAL_MB`, 8192) is a last-resort safety.

All `.jsonl` files are one JSON object per line, UTF-8, appended. `t` is always
milliseconds since the Unix epoch (wall clock of the agents service). Game
coordinates are tiles, relative to the world's origin (same as `/api/state`).
A torn last line is possible after a crash; skip lines that don't parse.

## Layout

```
/data/logs/                              LOG_DIR
  <runId>-<startStamp>/                  one dir per agents-service start of a run
    events.jsonl                         run events (also served by /api/events)
    llm.jsonl                            every agent model call
    positions.jsonl                      where everyone is, once per turn; walk targets
    director.jsonl                       stream camera decisions
    lives.jsonl                          each slot's login into a body
    narration.jsonl                      narrator outputs
    outages.jsonl                        LLM-outage pauses
    fieldnotes.jsonl                     the 20-minute field notes
    lives/<playerId>[-n].jsonl           per-life event log
    <stem>.<YYYYMMDDTHHMMSSZ>[-k].jsonl  rotated generations (see below)
  research/                              spans runs and restarts
  inventions.jsonl, story.jsonl          span runs and restarts
/data/worlds/archive/<UTC stamp>/world.tar.gz   archived game worlds
```

A run (`runId`, e.g. `pilot1-r9-mwmrwf9l`) gets a new `<runId>-<startStamp>` dir
every time the agents service starts (deploys, hot updates, crashes). To get a
whole run, read every `<runId>-*` dir in stamp order.

### Rotation

A raw file past `LOG_MAX_FILE_MB` (32 MB) is renamed to
`<stem>.<UTC stamp of the rotation>.jsonl`, e.g. `llm.20261118T194512Z.jsonl`
(`-2`, `-3`, ... if two rotations fall in the same second), and a new live file
starts. Rotated names never change. To read one file's whole history in a run
dir: every rotated generation sorted by stamp (then `-k`), then the live file.
`rotatedFiles()` in `agents/src/events.ts` does exactly that. Dirs written
before 2026-11-18 may have legacy names `<file>.1` (newest), `.2`, ... (highest
oldest); those come before the stamped ones.

## Per-run files

### positions.jsonl (movement)

Two kinds of line.

**Snapshot** (no `kind`), after each turn's act window under the turn clock
(`TURN_CLOCK=1`), or every 10 s without it. Only when someone is visible.

```json
{"t":1763495112345,"turn":1234,"gameTime":1763490000.123,"players":[[4012,-35,118,23.4,0,1],[4015,-36,118,1.2,-4012,0]]}
```

- `turn`: turn number of this agents-service process (restarts at 1 after a
  restart; `null` without the turn clock). `gameTime`: the game server's clock
  (seconds) reached at the end of the act window (`null` without the turn clock).
- `players`: every living player any of our living agents can see, merged across
  their views (the freshest sighting per player, the same view as `/api/state`),
  sorted by id. Each entry is `[id, x, y, age, heldId, moving]`:
  - `id`: game player id (`playerId` everywhere else; join with lives.jsonl,
    events.jsonl and `research/lives.*` for names, families and agents).
  - `x, y`: tile now (a carried baby has its carrier's tile; someone walking is
    interpolated along the path).
  - `age`: years, 1 decimal.
  - `heldId`: object id in hand (OneLifeData7 `objects/<id>.txt`), 0 empty,
    negative = carrying the baby with player id `-heldId`.
  - `moving`: 1 while walking.

**Walk** (`kind: "walk"`): one of our agents starts a walk (a `go`, an
`approach`, or a walk inside another action such as forage or a craft).

```json
{"t":1763495112400,"kind":"walk","id":4012,"from":[-35,118],"to":[-20,130]}
```

`to` is the tile the agent asked for (for `approach`, the target object's
tile; the walk ends next to it). It may not be reached (blocked, interrupted,
too long: see the matching `action` event's result).

Size: a snapshot of 28 players is about 0.85 KB. At the live turn rate
(about 3 turns/min) that is ~0.15 MB/h, ~0.25 MB/h at 5 turns/min; walk lines
(~80 bytes) add at most ~0.4-0.7 MB/h even if every agent walked every turn.
Without the turn clock: ~0.3 MB/h. Well under 5 MB/h.

### events.jsonl

The run's event stream (`RunEvent` in `agents/src/api-types.ts`):
`{seq, t, kind, agentId, playerId, name, text, data?}`. `seq` increases across
restarts of the same run. Kinds: `birth`, `death`, `say`, `action`, `thought`,
`craft`, `narration`, `focus` (stream camera), `system` (run start/stop,
pauses, errors, reconnects). `data` holds the details (positions, who heard a
line, craft actors/targets, cause of death, ...).

### llm.jsonl

One line per agent model call. Decisions:
`{t, agentId, playerId, lifeIndex, observation, reply, latencyMs, promptTokens, completionTokens, cachedTokens, cacheWriteTokens, reasoningTokens, costUsd, model, provider, ttftMs, reasoning?, finishReason}`
(`observation` is the full user message the model saw, `reply` its raw JSON
answer; fields from `llmLogFields` in `agents/src/agent/llm.ts`). Memory
summaries have `kind: "summary"` with `input`, `reply`, `memory`. Failed calls:
`{t, agentId, playerId, error}`. The biggest file (~150 MB/day).

### director.jsonl

Stream camera decisions: `kind: "decision"` (who to follow, `via`
single/heuristic/llm/jev, `cause`, prompt and reply for model decisions),
`"cutaway-decision"` (take or not, score, reason), `"death-hold"`.

### lives.jsonl

Each slot's arrival in a body: `{t, agentId, lifeIndex, playerId, eve, motherId, eveId, x, y}`,
or `{..., reconnect: true}` when an agent logs back into a still-living body.

### narration.jsonl

Narrator outputs `{t, input, text, costUsd, latencyMs}`; `{t, dropped: true, finishReason, text}` when discarded.

### outages.jsonl

`{t, event: "paused", since, reason}` / `{t, event: "resumed", since, pausedAt}`
when an LLM provider outage paused the run.

### fieldnotes.jsonl

`FieldNote`: `{t, runId, windowStart, windowEnd, text, model, costUsd}`, one
per 20-minute window.

### lives/<playerId>.jsonl

Per-life copy of that character's events (birth, death, thought, say, action,
craft), the source for `/api/lives/<id>/log`. `<playerId>-<n>.jsonl` when the
server reused a player id.

## Across runs

- `research/lives.snapshot.json` (+ `.prev.json`): every life record (traits,
  family, birth/death, cause, ...), rewritten every few minutes.
  `research/lives.journal.jsonl`: changes since the snapshot, one full record
  per line, last line per `lifeId` wins (compacted at startup). Together they
  are the life/lineage database (`agents/src/lifestore.ts`).
- `research/spend.jsonl`: `{t, usd}` per LLM cost, the rolling 24 h ledger.
- `research/current-run.json`: the run a continuous restart resumes.
- `research/explored-<runId>.json`: every map cell any agent has seen (the minimap).
- `inventions.jsonl`: first time each technology item was made, per run.
- `story.jsonl`: versions of "the story so far".
- `/data/worlds/archive/<stamp>/world.tar.gz`: the game server's world (map,
  players, server logs) when a world was regenerated; the newest few within
  `WORLD_ARCHIVE_MAX_MB` are kept on the server, the backup keeps all it saw.

Snapshot, journal, spend and current-run files are rewritten in place, so each
backup that sees them changed carries a fresh copy; the latest backup wins.

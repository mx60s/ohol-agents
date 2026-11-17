# Game saves: keeping living characters across server restarts

**Date:** 2026-11-16 · **Code read:** upstream `OneLife_liveServer` `server/server.cpp`, with our patches applied (`server/patches/*.patch`, `integrate` at `6b0ce3a`).
**Outcome:** feasible. Implemented as `server/patches/player-saves.patch` (setting `mtsPlayerSaves`). See "Implementation" and "Test results" below.

Stock OHOL keeps the map in its `.db` files, but living players exist only in memory (`SimpleVector<LiveObject> players`). After a restart or crash every living character is gone, with no death logged. The map, graves, eve.db and the lifeLog are all on disk.

## Phase 1: feasibility

### The key observation: restore players as "disconnected", not "pending"

Stock already handles a living player whose client went away. `setPlayerDisconnected()` sets `connected = false` and frees the socket. The player stays in `players`, in the world, aging and starving. When a client logs in with the same email, `processLoggedInPlayer()` (the "see if player was previously disconnected" loop near the top) hands the new socket to the existing `LiveObject`, sets `firstMessageSent = false`, and returns. Plain `LOGIN` passes `inAllowOrForceReconnect = true`, so a normal login reattaches.

On reconnect the main loop then sends the full first message, built from the player's current fields:
- the map chunk and `VS`
- `PU` for every living player (self included)
- `PO` for those out of range
- `PM` for moves in progress
- `HL`
- `LN` (lineage for everyone)
- `NM` (names)
- `CU`/`CS` (curses)
- follow and exile messages, `DY` (dying), the war report, bad biomes, `GH` (ghosts) and `PE` (emotes)

So if the save is rebuilt into real `LiveObject`s at startup, marked disconnected, the stock reconnect path does everything the client protocol needs. The player reappears at the saved position with the same id, `displayID`, name and lineage. Nothing new is needed on the wire.

Restoring everyone eagerly, at startup and before the first client connects, has two more benefits:
- **Relationships come back together.** A mother holding a baby is restored with `holdingID = -babyID` and the baby with `heldByOther`, in one pass, whoever reconnects first.
- **No "pending" state.** A player is either alive in `players` or not there at all.

For the same reason, pending entries are not keyed by email: the stock loop already does the email match.

### Building a LiveObject without re-implementing birth

`LiveObject` has about 150 fields, and `processLoggedInPlayer()` (~2,600 lines) initializes them. It already takes `inForceParentID = -2` (force Eve: no mother is picked, so no mother loses food or gets a birth cooldown), `inForceDisplayID`, `inForcePlayerPos` (skips `getEvePosition`, so eve.db and Eve placement are untouched) and `inSkipBirthLogging` (no lifeLog birth line). Twins use them.

The restore calls it with those arguments and a NULL socket. Then, just before the new object is pushed into `players`, one hook overwrites the saved fields and returns early. That skips the post-birth side effects:
- recent-score pool
- ancestor "new offspring" notices
- `logHomelandBirth`
- language registration (it is redone correctly, see below)

Every field not in the save keeps its fresh-birth initial value. That is the same state a reconnecting client meets anyway (paths cleared, no pending action).

### Fields

**Saved:**

| Group | Fields |
|---|---|
| Identity | `email`, `id`, `displayID`, `name`, `familyName`, `nameHasSuffix`, `isEve`, `isTwin` |
| Lineage | `parentID`, `parentChainLength` (generation), `lineage` (mother, grandmother, …), `lineageEveID`, and the four `ancestor*` vectors (ids, emails, relation names, life start times) |
| Leadership | `followingID`, `leadingColorIndex`, `exiledByIDs`, `ownedPositions` (property is only in memory, on the owner) |
| Time | `lifeStartTimeSeconds` (age), `trueStartTimeSeconds` |
| Position | current spot: the partial-move spot if mid-walk, the holder's spot if held; `facingLeft`, `originalBirthPos`, `birthPos` (0,0 under absolute-coords) |
| Food | `foodStore`, `foodCapModifier`, `foodDecrementETASeconds`, `yummyFoodChain`, `yummyBonusStore`, `lastAteID`/`FillMax`, craving (food and unique id, yum increment), `personalEatBonus`, `personalFoodDecrementSecondsBonus`, `drunkenness`, `fever` |
| Heat | `bodyHeat`, `heat`, `envHeat`, `biomeHeat`, `lastBiomeHeat` |
| Hands | `holdingID` (negative = a baby), `holdingEtaDecay`, contained and sub-contained ids with decay ETAs, `embeddedWeaponID` and its ETA |
| Clothing | each of the 6 slots: object, decay ETA, contained ids with ETAs (backpack and basket contents) |
| Held baby | `heldByOther`, `heldByOtherID`, `everHeldByParent` |
| Wounds | `dying`, `dyingETA`, `holdingWound`, `holdingBiomeSickness`, `murderSourceID`, `murderPerpID`, `murderPerpEmail`, `deathSourceID` |
| Motherhood | `babyBirthTimes`, `babyIDs`, `birthCoolDown`, `lastBabyEmail`, `sidsBabyEmails`, `everHomesick` |
| Account-ish | curse level and points, `lifeStats`, `fitnessScore`, `curseTokenCount`, tool slots and learned or partly learned tools, `permanentEmots`, `everKilledAnyone` |

**Recomputed or reset** (fresh-birth values are correct or harmless):
- the socket and buffers, `connected` (false until the client returns), and the first-message and map-sent flags
- move path state (a restored player stands still), the action target, and held origin (set to the player's position)
- heat map: recomputed the first time they stop
- `curseWords`, `special`, `ofp`, `isLastLifeShort`: computed from the email
- flood counters, emote windows, last-say time, global message queue
- the current order, VOG mode (saved at the pre-VOG position), monument call memory, known owned positions, posse size

**Not saved:**
- ghosts and tutorial players (skipped)
- players already flagged `error` (dying this step)

### Family and lineage vs the DBs

Lineage lives on the player:
- `lineageEveID` is the founding Eve's player id.
- `lineage` is the list of ancestor ids, mother first.
- `parentChainLength` is the generation.
- the `ancestor*` vectors list living relatives at birth, for scoring and for `+FAMILY+` markers.

eve.db only remembers where Eves were placed and Eve respawn spots. `lineageLimit` is time and email based. Neither keys on living player ids, so restoring ids is consistent with them.

**The real catch is ids.** `nextID` restarts from `nextPlayerID.ini`, and `server/run.sh` wipes `settings/` on every start, so ids restart at 2 after every restart today. The save stores `nextID`, and the restore sets `nextID = max(nextID, saved nextID, max restored id + 1)`. New players can then never reuse a restored id, which would break `parentID`, `lineage`, `heldByOtherID` and the ancestor links.

**Languages.** These are in-memory counts per `lineageEveID`, and a lineage whose count reaches 0 has its homelands declared dead. Each restored player is re-registered: the count is incremented, or a record is created if it is the first of its line. Otherwise their eventual death would wrongly kill a lineage's homeland.

Cravings are an in-memory list per lineage. Restoring a player's current craving is enough: `getCravedFood` regrows the list.

### Time

Every absolute timestamp on a player is game clock (`server.cpp` routes `Time::` through `mtsGameTime.h`). That covers `lifeStartTimeSeconds`, `trueStartTimeSeconds`, `foodDecrementETASeconds`, `dyingETA`, `birthCoolDown`, baby birth times, and all decay ETAs on held, contained and worn items. The save writes absolute values plus the game time and wall time of the save.

**Time pauses during the outage** (`mtsPlayerSavesPauseDowntime=1`, default). Every restored timestamp is shifted by `gameNow - gameAtSave`, so ages, hunger timers, wound timers and held-item decay all resume where they were. (The time-scale epoch file keeps the game clock continuous across restarts, so this shift is exactly the downtime ÷ timeScale.)

The map itself is not paused: things on the ground keep their DB decay ETAs and "catch up" after a long outage, as they do in stock. Held and worn items pause with the player.

With `=0`, the outage counts: everyone comes back older and hungrier, and may die on the first step.

A restored player who has not reconnected yet is alive and disconnected. As in stock, they age and get hungry while waiting.

### Held and contained objects, clothing

All of these are plain ids and ETAs on the `LiveObject` (`holdingID`, `containedIDs`, `subContainedIDs`, `clothing`, `clothingContained`). They are saved and restored as-is.

On load, every id is checked with `getObject()`. An unknown object id is dropped (set to empty), and a player with an unknown `displayID` is skipped, so a data-version change can't crash the restore.

### Babies and relationships between restored players

After everyone is restored, a consistency pass runs:
- A baby with `heldByOther` whose holder is missing, or whose holder's `holdingID` is not `-baby`, is set down: `heldByOther = false`, at the holder's last spot, which is where the save put the baby.
- A holder whose baby is missing is cleared to `holdingID = 0`.
- A consistent pair is kept as a real carry, and the baby's position follows the holder.

Families stay linked because `parentID`, `lineage`, `lineageEveID` and the ancestor lists are restored with the original ids.

### What happens to players who never come back

`mtsPlayerSavesMaxWaitSeconds` (default 900 s of real time) is the cutoff. A restored player who has not reconnected by then dies the normal way:
- `error` is set with death reason `disconnected`, which is what stock does to disconnected players in shutdown mode
- a grave is placed
- their held baby is dropped
- the lifeLog gets a death line

This keeps the world from filling with abandoned bodies when the agents service comes back with different emails. With `0`, they stay as stock disconnected players until they starve or age out.

A save older than `mtsPlayerSavesMaxDowntimeSeconds` (default 1800 s of real time) is ignored as a whole and renamed `playerSaves.txt.stale`. It is one snapshot, so its entries all have the same age.

### Risks and limits

- **Crash window.** The save is periodic (`mtsPlayerSavesIntervalSeconds`, default 30 s). After `kill -9`, players roll back up to 30 s, but the map does not. An item picked up from the ground after the last save is lost. An item dropped after it exists twice, on the ground and in hand. A baby born after the last save is gone, though the mother's food loss is rolled back too. A graceful SIGTSTP shutdown saves at exit, so it is exact.
- **Map DB after kill -9** is stock behaviour and out of scope here. Any unflushed DB writes are lost either way.
- **Not saved:** in-flight actions and paths (players come back standing), current orders, monument memory, VOG mode, the heat map (recomputed), emote freeze, war/peace and other global in-memory server state (peace treaties, cravings list, language maps, curse tests), and tutorial players and ghosts.
- **lifeLog and stats.** The restore writes no birth line and the shutdown writes no death line, so a restored life is one birth and, later, one death in the logs. That is the faithful result.
- **The save file is untrusted input.** It is parsed with bounds checks. Any parse error, version mismatch or missing `END` trailer means the whole file is ignored, logged, and renamed `playerSaves.txt.bad`. It never crashes the server.
- **Agents must log in with the same email** after a restart. That is the other half of this feature, in the agents service. Without it, restored players stand idle, then die after `mtsPlayerSavesMaxWaitSeconds`.

## Implementation

`server/patches/player-saves.patch` adds `server/mtsPlayerSaves.h`. It also adds five hooks in `server.cpp`:
1. the include
2. the restore hook and early return inside `processLoggedInPlayer`
3. restore at startup, just before the main loop
4. a periodic save and the max-wait check at the top of each main-loop step
5. a final save after the main loop exits on SIGTSTP

The save file is `playerSaves.txt` in the run dir. It is written to `playerSaves.txt.tmp` and then `rename()`d, so a crash mid-write leaves the previous save intact. It is a versioned text format, one player per line, strings %-escaped.

Settings (all read at startup; `server/settings/mtsPlayerSaves.ini` turns it on for our runs):

| Setting | Default | Meaning |
|---|---|---|
| `mtsPlayerSaves` | 0 | 1 = save and restore. 0 = stock: no file is read or written, no hook does anything |
| `mtsPlayerSavesIntervalSeconds` | 30 | real seconds between periodic saves |
| `mtsPlayerSavesMaxDowntimeSeconds` | 1800 | ignore a save older than this (real seconds) |
| `mtsPlayerSavesMaxWaitSeconds` | 900 | restored players not back within this long die (0 = never) |
| `mtsPlayerSavesPauseDowntime` | 1 | shift restored timestamps so the outage doesn't age anyone |

## Test results (2026-11-16)

**Setup:**
- the patched build in `/tmp/ohol-save-build`, a fresh run dir, port 8051
- `mtsPlayerSavesIntervalSeconds=5`
- scripted clients on `agents/src/protocol/connection.ts`

A is an Eve and B is a second login, born to A. A walks 2 tiles, says "I AM TESTA", picks B up and names her ("YOU ARE BOBBY"). Ages in the table are client-computed: PU age plus the time since, ÷ age_r.

| Step | A (mother) | B (baby) |
|---|---|---|
| before `kill -9` (last save 3 s before the kill) | id 2, EVE TESTA, display 2464, (50,-65), age 14.24 at the last print, holding -3 (B), food 17/18, LN `2 eve=2` | id 3, BOBBY TESTA, display 2404, (50,-65), age 0.17, food 4/4, LN `3 2 eve=2` |
| restart after **32 s down**, same emails log in | id 2, EVE TESTA, display 2464, (50,-65), age 14.29 (an unpaused clock would read about 14.8), **still holding -3**, food 17/18, LN `2 eve=2` | id 3, BOBBY TESTA, display 2404, (50,-65), age 0.22, food 4/4, LN `3 2 eve=2` |
| A drops B at (51,-65), walks to (55,-65), picks up a Flat Rock (291), then **SIGTSTP** | age about 15.01 at the stop, holding 291 | at (51,-65), on the ground, age about 0.94 |
| restart after **25 s down**, reconnect | (55,-65), age 15.06, **holding 291 (Flat Rock)**, food 17/19, same id, name and LN | (51,-65), on the ground, age 0.99, same id, name and LN |
| stop, restart with `TIME_SCALE=4` and `mtsPlayerSavesMaxWaitSeconds=15`; only A logs in | age 15.51, age_r 240, holding 291, LN and NM intact | never logs in. After 15 s she dies (PU `reason_disconnected`; lifeLog `D … 3 … age=1.50 … hunger`) |

**Other checks:**
- **Corrupt saves.** Three cases: the file truncated mid-line, a non-numeric field, and 4 KB of random bytes on a player line. Each one logged "save file is corrupt", the file was renamed `playerSaves.txt.bad`, and the server started normally with nobody restored.
- **Stale save.** With `mtsPlayerSavesMaxDowntimeSeconds=5` and a save 12 s old, the save was not restored and the file was renamed `.stale`.
- **`mtsPlayerSaves=0`.** A save file in the run dir was ignored and left byte-for-byte untouched; no file was written on exit. The same email was born as a fresh Eve, which is stock behaviour.
- **Orphaned held baby.** Mother A's line was deleted from a save in which A held B. B was restored on the ground at A's last spot (log: "3 was held by 2, set down").
- **New login after a restore.** A new email got id 5, not a restored id. Without the `nextID` bump, ids would restart at 2, because `run.sh` wipes `settings/` on every start.
- **Patch order.** `build.sh`-order application of all patches to a pristine upstream checkout yields byte-identical `server.cpp`, `map.cpp`, `mtsGameTime.h` and `mtsPlayerSaves.h` to the tested tree.

**Known gaps:**
- A `kill -9` rolls players back up to one save interval, but the map does not roll back (see Risks).
- A restored mother still waiting for her client can be picked for a new baby, as any disconnected mother can in stock.
- A player who never comes back is logged as dying of `hunger` in the lifeLog, because `logDeath` has no "disconnected" cause. The PU reason is `disconnected`.
- In-flight actions and paths, orders, monument memory and global in-memory state (peace treaties, language maps, the cravings list) are not saved.
- Restoring needs the same run dir, for both the world DBs and `playerSaves.txt`, and the agents logging in with the same emails.

// Turns RawMessages (framed by connection.ts) into typed ServerMessages.
// Wire format reference: OneLife/server/protocol.txt (server -> client sections).
// Never throws: any per-message parse failure yields { type: "OTHER" }.

import type { RawMessage } from "./connection.ts";
import type {
  ServerMessage,
  PlayerUpdate,
  PlayerMove,
  MapChange,
  MapChunk,
  MapCell,
  ObjStack,
  PlayerSays,
  LocationSays,
  Lineage,
  PlayerName,
  Emote,
  Follow,
  Grave,
} from "./types.ts";

/** Parses an integer, rejecting junk. */
function int(s: string): number {
  const n = parseInt(s, 10);
  if (Number.isNaN(n)) throw new Error(`bad int: "${s}"`);
  return n;
}

/** Parses a float, rejecting junk. */
function num(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`bad number: "${s}"`);
  return n;
}

/** CONTAINER OBJECT FORMAT: "id" or "id,c1,c2:s1:s2,..." (two layers max). */
function parseObjStack(spec: string): ObjStack {
  const parts = spec.split(",");
  const id = int(parts[0]);
  const contained = parts
    .slice(1)
    .filter((p) => p.length > 0)
    .map((entry) => {
      const [head, ...subs] = entry.split(":");
      return { id: int(head), sub: subs.map(int) };
    });
  return { id, contained };
}

const flag = (s: string): boolean => s !== "0";

// p_id po_id facing action atx aty o_id o_origin_valid ox oy o_transition_source_id
// heat done_moving force x y age age_r move_speed clothing just_ate last_ate_id
// responsible_id held_yum held_learned [deathReason]
// Deleted players send "X X" for x y plus a trailing reason token.
function parsePlayerUpdate(line: string): PlayerUpdate {
  const f = line.trim().split(/\s+/);
  if (f.length < 25) throw new Error(`PU line has ${f.length} fields, need 25`);
  const deleted = f[14] === "X" || f[15] === "X";
  const u: PlayerUpdate = {
    id: int(f[0]),
    displayId: int(f[1]),
    facing: int(f[2]),
    action: flag(f[3]),
    actionTarget: [int(f[4]), int(f[5])],
    held: parseObjStack(f[6]), // negative id = holding baby with p_id -id
    heldOriginValid: flag(f[7]),
    heldOrigin: [int(f[8]), int(f[9])],
    heldTransitionSourceId: int(f[10]),
    heat: num(f[11]),
    doneMovingSeq: int(f[12]),
    forced: flag(f[13]),
    x: deleted ? null : int(f[14]),
    y: deleted ? null : int(f[15]),
    age: num(f[16]),
    ageRate: num(f[17]),
    moveSpeed: num(f[18]),
    clothing: f[19].split(";").map(parseObjStack), // hat;tunic;frontShoe;backShoe;bottom;backpack
    justAte: flag(f[20]),
    lastAteId: int(f[21]),
    responsibleId: int(f[22]),
    heldYum: flag(f[23]),
    heldLearned: flag(f[24]),
  };
  if (deleted && f.length > 25) u.deathReason = f.slice(25).join(" ");
  return u;
}

// p_id xs ys total_sec eta_sec trunc xdelt0 ydelt0 ...
// Deltas are relative to the start; expand to absolute waypoints.
function parsePlayerMove(line: string): PlayerMove {
  const f = line.trim().split(/\s+/);
  if (f.length < 6) throw new Error(`PM line has ${f.length} fields, need 6+`);
  const sx = int(f[1]);
  const sy = int(f[2]);
  const path: [number, number][] = [];
  for (let i = 6; i + 1 < f.length; i += 2) {
    path.push([sx + int(f[i]), sy + int(f[i + 1])]);
  }
  return {
    id: int(f[0]),
    start: [sx, sy],
    totalSec: num(f[3]),
    etaSec: num(f[4]),
    truncated: flag(f[5]),
    path,
  };
}

// x y new_floor_id new_id p_id [old_x old_y speed]
function parseMapChange(line: string): MapChange {
  const f = line.trim().split(/\s+/);
  if (f.length < 5) throw new Error(`MX line has ${f.length} fields, need 5+`);
  const c: MapChange = {
    x: int(f[0]),
    y: int(f[1]),
    floor: int(f[2]),
    obj: parseObjStack(f[3]),
    responsibleId: int(f[4]),
  };
  if (f.length >= 8) {
    c.from = { x: int(f[5]), y: int(f[6]), speed: num(f[7]) };
  }
  return c;
}

// Header lines: "sizeX sizeY x y", "raw_size compressed_size".
// Payload: space-separated cells, row-major from (x, y), y increasing per row;
// each cell "biome:floor:object" with object in CONTAINER OBJECT FORMAT.
function parseMapChunk(raw: RawMessage): MapChunk {
  if (!raw.binary) throw new Error("MC missing binary payload");
  const header = (raw.lines[0] ?? "").trim().split(/\s+/);
  if (header.length < 4) throw new Error(`bad MC header: "${raw.lines[0]}"`);
  const w = int(header[0]);
  const h = int(header[1]);
  const x = int(header[2]);
  const y = int(header[3]);
  const tokens = raw.binary.toString("latin1").split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < w * h) {
    throw new Error(`MC has ${tokens.length} cells, expected ${w * h}`);
  }
  const cells: MapCell[] = tokens.map((tok) => {
    const parts = tok.split(":");
    if (parts.length < 3) throw new Error(`bad MC cell: "${tok}"`);
    // sub-contained items also use ':', so rejoin everything after floor
    return { biome: int(parts[0]), floor: int(parts[1]), obj: parseObjStack(parts.slice(2).join(":")) };
  });
  return { x, y, w, h, cells };
}

// p_id/isCurse text with spaces (text kept verbatim, may contain *map tokens)
function parsePlayerSays(line: string): PlayerSays {
  const sp = line.indexOf(" ");
  if (sp < 0) throw new Error(`PS line missing text: "${line}"`);
  const head = line.slice(0, sp);
  const slash = head.indexOf("/");
  if (slash < 0) throw new Error(`PS line missing '/': "${line}"`);
  return { id: int(head.slice(0, slash)), isCurse: head.slice(slash + 1) !== "0", text: line.slice(sp + 1) };
}

// x y text with spaces
function parseLocationSays(line: string): LocationSays {
  const m = /^(\S+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!m) throw new Error(`bad LS line: "${line}"`);
  return { x: int(m[1]), y: int(m[2]), text: m[3] };
}

// p_id mother grandmother ... eve=eve_id  (or just "p_id eve=p_id")
function parseLineage(line: string): Lineage {
  const f = line.trim().split(/\s+/);
  if (f.length < 2) throw new Error(`bad LN line: "${line}"`);
  const id = int(f[0]);
  const eveIdx = f.findIndex((t, i) => i > 0 && t.startsWith("eve="));
  if (eveIdx < 0) {
    // no eve= token: fall back to the last listed ancestor (or self)
    const ancestors = f.slice(1).map(int);
    return { id, ancestors, eveId: ancestors.length > 0 ? ancestors[ancestors.length - 1] : id };
  }
  return { id, ancestors: f.slice(1, eveIdx).map(int), eveId: int(f[eveIdx].slice(4)) };
}

// p_id first_name [last_name]
function parsePlayerName(line: string): PlayerName {
  const f = line.trim().split(/\s+/);
  if (f.length < 2) throw new Error(`bad NM line: "${line}"`);
  const n: PlayerName = { id: int(f[0]), first: f[1] };
  if (f.length > 2) n.last = f.slice(2).join(" ");
  return n;
}

// p_id emot_index [ttl_sec]
function parseEmote(line: string): Emote {
  const f = line.trim().split(/\s+/);
  if (f.length < 2) throw new Error(`bad PE line: "${line}"`);
  const e: Emote = { id: int(f[0]), emot: int(f[1]) };
  if (f.length > 2) e.ttl = int(f[2]);
  return e;
}

// follower_id leader_id leader_color_index
function parseFollow(line: string): Follow {
  const f = line.trim().split(/\s+/);
  if (f.length < 3) throw new Error(`bad FW line: "${line}"`);
  return { followerId: int(f[0]), leaderId: int(f[1]), colorIndex: int(f[2]) };
}

// x y p_id
function parseGrave(line: string): Grave {
  const f = line.trim().split(/\s+/);
  if (f.length < 3) throw new Error(`bad GV line: "${line}"`);
  return { x: int(f[0]), y: int(f[1]), id: int(f[2]) };
}

/** All whitespace-separated tokens across the message's lines. */
function tokens(lines: string[]): string[] {
  return lines
    .join(" ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function parseInner(raw: RawMessage): ServerMessage {
  const lines = raw.lines;
  switch (raw.type) {
    case "PU":
      return { type: "PU", updates: lines.map(parsePlayerUpdate) };
    case "PM":
      return { type: "PM", moves: lines.map(parsePlayerMove) };
    case "PO":
      return { type: "PO", ids: lines.map((l) => int(l.trim())) };
    case "MX":
      return { type: "MX", changes: lines.map(parseMapChange) };
    case "MC":
      return { type: "MC", chunk: parseMapChunk(raw) };
    case "PS":
      return { type: "PS", says: lines.map(parsePlayerSays) };
    case "LS":
      return { type: "LS", says: lines.map(parseLocationSays) };
    case "FX": {
      // food capacity last_ate_id last_ate_fill_max move_speed responsible_id yum_bonus yum_multiplier
      const f = tokens(lines);
      if (f.length < 8) throw new Error(`FX has ${f.length} fields, need 8`);
      return {
        type: "FX",
        food: {
          food: int(f[0]),
          capacity: int(f[1]),
          lastAteId: int(f[2]),
          lastAteFillMax: int(f[3]),
          moveSpeed: num(f[4]),
          responsibleId: int(f[5]),
          yumBonus: int(f[6]),
          yumMultiplier: int(f[7]),
        },
      };
    }
    case "HX": {
      // heat food_time indoor_bonus
      const f = tokens(lines);
      if (f.length < 3) throw new Error(`HX has ${f.length} fields, need 3`);
      return { type: "HX", heat: { heat: num(f[0]), foodTime: num(f[1]), indoorBonus: num(f[2]) } };
    }
    case "LN":
      return { type: "LN", lineages: lines.map(parseLineage) };
    case "NM":
      return { type: "NM", names: lines.map(parsePlayerName) };
    case "DY": // "p_id [isSick]" per line; we only keep the id
      return { type: "DY", ids: lines.map((l) => int(l.trim().split(/\s+/)[0])) };
    case "HE":
      return { type: "HE", ids: lines.map((l) => int(l.trim())) };
    case "BW":
      return { type: "BW", ids: lines.map((l) => int(l.trim())) };
    case "PE":
      return { type: "PE", emotes: lines.map(parseEmote) };
    case "CR": {
      // food_id bonus
      const f = tokens(lines);
      if (f.length < 2) throw new Error(`CR has ${f.length} fields, need 2`);
      return { type: "CR", craving: { foodId: int(f[0]), bonus: int(f[1]) } };
    }
    case "FW":
      return { type: "FW", follows: lines.map(parseFollow) };
    case "GV":
      return { type: "GV", graves: lines.map(parseGrave) };
    case "LR": {
      const f = tokens(lines);
      if (f.length === 0) throw new Error("LR with no tool ids");
      return { type: "LR", toolIds: f.map(int) };
    }
    case "TS": {
      // used total
      const f = tokens(lines);
      if (f.length < 2) throw new Error(`TS has ${f.length} fields, need 2`);
      return { type: "TS", used: int(f[0]), total: int(f[1]) };
    }
    case "FM":
      return { type: "FM" };
    case "PONG": {
      const id = (lines[0] ?? "").trim();
      if (id.length === 0) throw new Error("PONG missing id");
      return { type: "PONG", id };
    }
    default:
      return { type: "OTHER", tag: raw.type, lines };
  }
}

/** Parses one framed raw message into a typed ServerMessage. Never throws. */
export function parseMessage(raw: RawMessage): ServerMessage {
  try {
    return parseInner(raw);
  } catch {
    return { type: "OTHER", tag: raw.type, lines: raw.lines };
  }
}

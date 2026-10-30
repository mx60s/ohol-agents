import { useEffect, useMemo, useRef } from "react";
import type {
  AgentView,
  MapCellTuple,
  PlayerView,
  RunEvent,
} from "./api-types";
import { agentColor, BIOME_COLORS, UNKNOWN_BIOME } from "./MapCanvas";
import { clockNow, speechScale } from "./api";

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

// appearance palettes (picked deterministically by player id hash)
const SKIN_TONES = ["#8d5524", "#a5673f", "#c68642", "#e0ac69", "#f1c27d", "#ffdbac"];
const HAIR_COLORS = ["#17130f", "#3b2a1a", "#6b4423", "#a56b2f", "#c9a063", "#b5522a"];
const SHIRT_COLORS = ["#7a4a8f", "#3f6b8f", "#8f3f46", "#4a7a3f", "#8f7a3f", "#546a7b"];

const REACH_VERBS = /^(use|pick_up|pick up|drop|eat|feed)\b/i;
const SPEECH_MS = 6000;
const REACH_MS = 1200;

function hashNum(n: number): number {
  let h = (n * 2654435761) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

interface Tween {
  x0: number;
  y0: number;
  t0: number;
  x1: number;
  y1: number;
  t1: number;
}

function sampleTween(tw: Tween, now: number): { x: number; y: number } {
  if (now >= tw.t1) return { x: tw.x1, y: tw.y1 };
  const k = (now - tw.t0) / Math.max(1, tw.t1 - tw.t0);
  return { x: tw.x0 + (tw.x1 - tw.x0) * k, y: tw.y0 + (tw.y1 - tw.y0) * k };
}

export interface CameraGridProps {
  agents: AgentView[];
  players: PlayerView[];
  cells: MapCellTuple[];
  names: Record<number, string>;
  says: RunEvent[];
  onSelect: (agent: AgentView) => void;
}

export default function CameraGrid(props: CameraGridProps) {
  const { agents, cells } = props;

  const cellIndex = useMemo(() => {
    const m = new Map<string, MapCellTuple>();
    for (const c of cells) m.set(`${c[0]},${c[1]}`, c);
    return m;
  }, [cells]);

  // track when each agent's lastAction last changed (for reach animations)
  const actionRef = useRef(new Map<string, { action: string; t: number }>());
  const prevActionRef = useRef(new Map<string, string | null>());
  useEffect(() => {
    const now = Date.now();
    for (const a of agents) {
      if (a.lastAction && a.lastAction !== prevActionRef.current.get(a.agentId)) {
        actionRef.current.set(a.agentId, { action: a.lastAction, t: now });
      }
      prevActionRef.current.set(a.agentId, a.lastAction);
    }
  }, [agents]);

  const n = agents.length || 1;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
  const rows = Math.max(1, Math.ceil(n / cols));

  return (
    <div
      className="cam-grid"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
      }}
    >
      {agents.map((a) => (
        <CameraTile
          key={a.agentId}
          agent={a}
          players={props.players}
          cellIndex={cellIndex}
          names={props.names}
          says={props.says}
          actions={actionRef.current}
          onSelect={props.onSelect}
        />
      ))}
      {agents.length === 0 && <div className="dim cam-empty">no agents yet</div>}
    </div>
  );
}

interface CameraTileProps {
  agent: AgentView;
  players: PlayerView[];
  cellIndex: Map<string, MapCellTuple>;
  names: Record<number, string>;
  says: RunEvent[];
  actions: Map<string, { action: string; t: number }>;
  onSelect: (agent: AgentView) => void;
}

function CameraTile(props: CameraTileProps) {
  const { agent, players } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const tweensRef = useRef(new Map<number, Tween>());
  const sizeRef = useRef({ w: 160, h: 100 });

  const me = players.find(
    (p) =>
      p.agentId === agent.agentId ||
      (agent.playerId != null && p.id === agent.playerId),
  );
  const live = agent.status === "alive" && me != null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      sizeRef.current = { w: rect.width, h: rect.height };
    });
    ro.observe(canvas);

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const p = propsRef.current;
      const { w, h } = sizeRef.current;
      if (w <= 0 || h <= 0) return;
      const now = Date.now();

      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0d1013";
      ctx.fillRect(0, 0, w, h);

      const agentPlayer = p.players.find(
        (pl) =>
          pl.agentId === p.agent.agentId ||
          (p.agent.playerId != null && pl.id === p.agent.playerId),
      );
      if (p.agent.status !== "alive" || !agentPlayer) return; // dark tile, HTML overlay covers it

      // ---- advance position tweens toward latest polled positions ----
      const tweens = tweensRef.current;
      const seen = new Set<number>();
      const interp = new Map<number, { x: number; y: number; walking: boolean }>();
      for (const pl of p.players) {
        seen.add(pl.id);
        let tw = tweens.get(pl.id);
        if (!tw) {
          tw = { x0: pl.x, y0: pl.y, t0: now, x1: pl.x, y1: pl.y, t1: now };
          tweens.set(pl.id, tw);
        }
        if (tw.x1 !== pl.x || tw.y1 !== pl.y) {
          const cur = sampleTween(tw, now);
          const dur = Math.min(2000, Math.max(250, now - tw.t0));
          tw.x0 = cur.x;
          tw.y0 = cur.y;
          tw.t0 = now;
          tw.x1 = pl.x;
          tw.y1 = pl.y;
          tw.t1 = now + dur;
        }
        const pos = sampleTween(tw, now);
        const midMove =
          now < tw.t1 && Math.hypot(tw.x1 - tw.x0, tw.y1 - tw.y0) > 0.01;
        interp.set(pl.id, { x: pos.x, y: pos.y, walking: pl.moving === true || midMove });
      }
      for (const id of [...tweens.keys()]) {
        if (!seen.has(id)) tweens.delete(id);
      }

      const camPos = interp.get(agentPlayer.id) ?? agentPlayer;
      const camX = camPos.x;
      const camY = camPos.y;

      const cellPx = Math.min(w / 13, h / 9);
      const toSX = (wx: number) => w / 2 + (wx - camX) * cellPx;
      const toSY = (wy: number) => h / 2 - (wy - camY) * cellPx;

      // ---- ground cells: 13 x 9 window around the agent ----
      const bx = Math.round(camX);
      const by = Math.round(camY);
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -6; dx <= 6; dx++) {
          const cx = bx + dx;
          const cy = by + dy;
          const sx = toSX(cx - 0.5);
          const sy = toSY(cy + 0.5);
          const cell = p.cellIndex.get(`${cx},${cy}`);
          if (!cell) {
            ctx.fillStyle = "#14181d";
            ctx.fillRect(sx, sy, cellPx + 1, cellPx + 1);
            continue;
          }
          const [, , biome, floorId, objectId] = cell;
          ctx.fillStyle = BIOME_COLORS[biome] ?? UNKNOWN_BIOME;
          ctx.fillRect(sx, sy, cellPx + 1, cellPx + 1);
          if (floorId > 0) {
            ctx.fillStyle = "rgba(122, 74, 32, 0.45)";
            ctx.fillRect(sx, sy, cellPx + 1, cellPx + 1);
          }
          if (objectId > 0) {
            const raw = p.names[objectId];
            drawObject(ctx, raw ?? "", toSX(cx), toSY(cy), cellPx);
            if (raw && cellPx >= 24) {
              const base = raw.split("#")[0].trim();
              ctx.font = `8px ${MONO_FONT}`;
              ctx.textAlign = "center";
              ctx.textBaseline = "alphabetic";
              ctx.fillStyle = "rgba(10, 12, 14, 0.7)";
              ctx.fillText(truncate(base, 13), toSX(cx) + 1, toSY(cy) + cellPx * 0.48 + 1);
              ctx.fillStyle = "rgba(232, 236, 240, 0.8)";
              ctx.fillText(truncate(base, 13), toSX(cx), toSY(cy) + cellPx * 0.48);
            }
          }
        }
      }

      // ---- who is carrying a baby? ----
      const carriers = p.players.filter(
        (pl) => pl.held != null && pl.held.toLowerCase().startsWith("baby"),
      );
      const carriedBy = new Map<number, PlayerView>(); // babyId -> carrier
      for (const pl of p.players) {
        if (pl.age >= 3) continue;
        const pos = interp.get(pl.id);
        if (!pos) continue;
        for (const c of carriers) {
          if (c.id === pl.id) continue;
          const cp = interp.get(c.id);
          if (cp && Math.hypot(cp.x - pos.x, cp.y - pos.y) < 0.6) {
            carriedBy.set(pl.id, c);
            break;
          }
        }
      }

      // ---- characters, north (up) first so southern ones overlap ----
      const visible = p.players
        .filter((pl) => {
          const pos = interp.get(pl.id);
          if (!pos) return false;
          const sx = toSX(pos.x);
          const sy = toSY(pos.y);
          return sx > -40 && sx < w + 40 && sy > -60 && sy < h + 60;
        })
        .sort((a, b) => (interp.get(b.id)?.y ?? 0) - (interp.get(a.id)?.y ?? 0));

      const saysByPlayer = new Map<number, RunEvent[]>();
      const evNow = clockNow();
      const speechMs = SPEECH_MS * speechScale();
      for (const ev of p.says) {
        if (ev.playerId == null || evNow - ev.t >= speechMs || evNow < ev.t) continue;
        const arr = saysByPlayer.get(ev.playerId);
        if (arr) arr.push(ev);
        else saysByPlayer.set(ev.playerId, [ev]);
      }

      // if this tile's own agent is a carried baby, highlight the carrier
      const focusCarrierId = carriedBy.get(agentPlayer.id)?.id;

      for (const pl of visible) {
        if (carriedBy.has(pl.id)) continue; // held in someone's arms
        const pos = interp.get(pl.id);
        if (!pos) continue;
        const tw = tweens.get(pl.id);
        const facing = tw && tw.x1 - tw.x0 !== 0 ? Math.sign(tw.x1 - tw.x0) : 1;
        const act = pl.agentId ? p.actions.get(pl.agentId) : undefined;
        const reach =
          act && now - act.t < REACH_MS && REACH_VERBS.test(act.action)
            ? Math.sin(((now - act.t) / REACH_MS) * Math.PI)
            : 0;
        const isFocus =
          pl.agentId === p.agent.agentId || pl.id === focusCarrierId;
        drawFigure(ctx, {
          x: toSX(pos.x),
          y: toSY(pos.y),
          u: cellPx,
          now,
          id: pl.id,
          age: pl.age,
          female: pl.female === true,
          walking: pos.walking,
          facing,
          dying: pl.dying,
          held: pl.held,
          carryingBaby: carriedBy.size > 0 && carriers.some((c) => c.id === pl.id),
          reach,
          highlight: isFocus ? agentColor(p.agent.agentId) : null,
          name: pl.name ?? pl.agentId ?? `#${pl.id}`,
        });

        // speech bubble
        const says = saysByPlayer.get(pl.id);
        if (says && says.length > 0) {
          const ev = says[says.length - 1];
          const text = truncate(ev.text, 44);
          ctx.font = `10px ${MONO_FONT}`;
          const tw2 = ctx.measureText(text).width;
          const bw = tw2 + 12;
          const bh = 15;
          const headTop = toSY(pos.y) - figureHeight(pl.age, cellPx) - 11;
          const bx2 = Math.min(Math.max(toSX(pos.x) - bw / 2, 2), w - bw - 2);
          const by2 = Math.max(headTop, bh + 2);
          ctx.fillStyle = "rgba(238, 240, 234, 0.95)";
          roundRect(ctx, bx2, by2 - bh, bw, bh, 4);
          ctx.fill();
          ctx.fillStyle = "#14161a";
          ctx.textAlign = "left";
          ctx.textBaseline = "alphabetic";
          ctx.fillText(text, bx2 + 6, by2 - bh + 11);
        }
      }
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const foodPct =
    agent.food != null && agent.foodCapacity
      ? Math.max(0, Math.min(100, (agent.food / agent.foodCapacity) * 100))
      : 0;

  return (
    <div className="cam-tile" onClick={() => props.onSelect(agent)}>
      <canvas ref={canvasRef} className="cam-canvas" />
      {live ? (
        <>
          <div className="cam-chip cam-stats">
            <div className={`cam-food${foodPct < 25 ? " low" : ""}`} title="food">
              <div style={{ width: `${foodPct}%` }} />
            </div>
            <span>
              heat {agent.heat != null ? `${Math.round(agent.heat * 100)}%` : "–"}
            </span>
          </div>
          <div className="cam-bottom">
            <div className="cam-tag">
              <span
                className="agent-dot"
                style={{ background: agentColor(agent.agentId) }}
              />
              {(agent.name ?? "unnamed").toUpperCase()} ({agent.agentId})
              {agent.age != null && ` · age ${Math.floor(agent.age)}`}
              {agent.generation != null && ` · gen ${agent.generation}`}
            </div>
            {agent.lastThought && (
              <div className="cam-caption">“{truncate(agent.lastThought, 72)}”</div>
            )}
          </div>
        </>
      ) : (
        <div className="cam-offline">
          <div className="cam-offline-title">
            {agent.status === "connecting"
              ? "connecting…"
              : agent.status === "alive"
                ? "no signal…"
                : "between lives…"}
          </div>
          <div className="cam-offline-sub">
            {agent.name ?? agent.agentId} · {agent.status}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// drawing helpers

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function figureHeight(age: number, u: number): number {
  if (age < 3) return u * 0.32;
  if (age < 14) return u * 0.6;
  if (age >= 40) return u * 0.85;
  return u * 0.95;
}

function drawObject(
  ctx: CanvasRenderingContext2D,
  rawName: string,
  cx: number,
  cy: number,
  u: number,
): void {
  const name = rawName.split("#")[0].toLowerCase();
  if (/(tree|pine|maple|juniper|poplar|cypress|willow)/.test(name)) {
    // trunk + round canopy
    ctx.fillStyle = "#5d4023";
    ctx.fillRect(cx - u * 0.05, cy - u * 0.05, u * 0.1, u * 0.32);
    ctx.beginPath();
    ctx.arc(cx, cy - u * 0.14, u * 0.27, 0, Math.PI * 2);
    ctx.fillStyle = "#2e5d23";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx - u * 0.09, cy - u * 0.2, u * 0.12, 0, Math.PI * 2);
    ctx.fillStyle = "#3d7430";
    ctx.fill();
  } else if (name.includes("bush")) {
    ctx.beginPath();
    ctx.ellipse(cx, cy + u * 0.05, u * 0.26, u * 0.19, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#3a6b2a";
    ctx.fill();
    if (!name.includes("empty")) {
      ctx.fillStyle = "#c2352b";
      for (const [ox, oy] of [[-0.1, 0], [0.08, 0.08], [0.02, -0.06]] as const) {
        ctx.beginPath();
        ctx.arc(cx + u * ox, cy + u * oy, u * 0.045, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (/(rock|stone|flint)/.test(name)) {
    ctx.beginPath();
    ctx.ellipse(cx, cy + u * 0.08, u * 0.2, u * 0.13, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#8b8f94";
    ctx.fill();
  } else if (/(water|pond)/.test(name)) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, u * 0.34, u * 0.26, 0, 0, Math.PI * 2);
    ctx.fillStyle = "#2e6f9e";
    ctx.fill();
  } else if (/(reed|grass|wheat|carrot|milkweed)/.test(name)) {
    ctx.strokeStyle = name.includes("wheat") ? "#d8c25a" : "#4f8f3a";
    ctx.lineWidth = Math.max(1, u * 0.04);
    for (const ox of [-0.12, -0.04, 0.04, 0.12]) {
      ctx.beginPath();
      ctx.moveTo(cx + u * ox, cy + u * 0.18);
      ctx.lineTo(cx + u * ox * 1.3, cy - u * 0.18);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = "#6b4a2a";
    ctx.fillRect(cx - u * 0.15, cy - u * 0.1, u * 0.3, u * 0.24);
  }
}

interface FigureOpts {
  x: number;
  y: number; // ground point (feet), screen coords
  u: number; // pixels per world cell
  now: number;
  id: number;
  age: number;
  female: boolean;
  walking: boolean;
  facing: number;
  dying: boolean;
  held: string | null;
  carryingBaby: boolean;
  reach: number; // 0..1 arm-reach animation progress
  highlight: string | null;
  name: string;
}

function drawFigure(ctx: CanvasRenderingContext2D, o: FigureOpts): void {
  const h = hashNum(o.id);
  const skin = SKIN_TONES[h % SKIN_TONES.length];
  const hair =
    o.age >= 40 ? "#b8b8b8" : HAIR_COLORS[(h >>> 3) % HAIR_COLORS.length];
  const shirt = SHIRT_COLORS[(h >>> 6) % SHIRT_COLORS.length];
  const phase = o.now / 120 + (h % 100);
  const swing = o.walking ? Math.sin(phase) : 0;
  const bob = o.walking
    ? Math.abs(Math.sin(phase)) * o.u * 0.03
    : Math.sin(o.now / 600 + h) * o.u * 0.012;
  const f = o.facing >= 0 ? 1 : -1;

  if (o.highlight) {
    ctx.beginPath();
    ctx.ellipse(o.x, o.y + 1, o.u * 0.3, o.u * 0.1, 0, 0, Math.PI * 2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = o.highlight;
    ctx.stroke();
  }

  if (o.dying) {
    const pulse = 0.22 + 0.14 * Math.sin(o.now / 150);
    ctx.beginPath();
    ctx.arc(o.x, o.y - figureHeight(o.age, o.u) * 0.5, o.u * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 59, 48, ${pulse})`;
    ctx.fill();
  }

  ctx.lineCap = "round";

  if (o.age < 3) {
    // baby: lying down bundle
    const bw = o.u * 0.3;
    ctx.fillStyle = shirt;
    ctx.beginPath();
    ctx.ellipse(o.x, o.y - o.u * 0.07 - bob, bw, o.u * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(o.x + f * bw * 0.9, o.y - o.u * 0.1 - bob, o.u * 0.09, 0, Math.PI * 2);
    ctx.fillStyle = skin;
    ctx.fill();
  } else {
    const H = figureHeight(o.age, o.u);
    const legLen = H * 0.34;
    const torsoLen = H * 0.38;
    const headR = H * 0.15;
    const hunch = o.age >= 40 ? H * 0.08 : 0;
    const hipY = o.y - legLen - bob;
    const shoulderY = hipY - torsoLen + hunch;
    const shoulderX = o.x + f * hunch;
    const headX = shoulderX + f * hunch * 0.6;
    const headY = shoulderY - headR * 1.05;

    // legs
    ctx.strokeStyle = "#2c2620";
    ctx.lineWidth = Math.max(1.5, H * 0.07);
    for (const side of [-1, 1]) {
      const fx = o.x + side * swing * H * 0.16 + side * H * 0.03;
      const fy = o.y - Math.max(0, side * swing) * H * 0.05;
      ctx.beginPath();
      ctx.moveTo(o.x, hipY);
      ctx.lineTo(fx, fy);
      ctx.stroke();
    }

    // torso
    ctx.strokeStyle = shirt;
    ctx.lineWidth = H * 0.2;
    ctx.beginPath();
    ctx.moveTo(o.x, hipY);
    ctx.lineTo(shoulderX, shoulderY);
    ctx.stroke();

    // arms (left rests, right reaches on action)
    ctx.strokeStyle = skin;
    ctx.lineWidth = Math.max(1.2, H * 0.06);
    const armLen = H * 0.3;
    // back arm
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY + H * 0.03);
    ctx.lineTo(
      shoulderX - f * armLen * 0.35 - swing * H * 0.08,
      shoulderY + H * 0.03 + armLen * 0.85,
    );
    ctx.stroke();
    // front arm (reach target)
    const reachAng = -0.35 - o.reach * 1.1; // rotate forward/up
    const handX =
      shoulderX + f * Math.cos(reachAng) * armLen + swing * H * 0.08 + o.reach * f * H * 0.12;
    const handY = shoulderY + H * 0.03 + Math.sin(-reachAng) * armLen + armLen * (1 - o.reach) * 0.55;
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY + H * 0.03);
    ctx.lineTo(handX, handY);
    ctx.stroke();

    // carried baby in arms
    if (o.carryingBaby) {
      const bx = shoulderX + f * H * 0.16;
      const by = shoulderY + H * 0.22;
      ctx.fillStyle = "#d9cbb8";
      ctx.beginPath();
      ctx.ellipse(bx, by, H * 0.16, H * 0.1, f * 0.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(bx + f * H * 0.12, by - H * 0.06, H * 0.065, 0, Math.PI * 2);
      ctx.fillStyle = skin;
      ctx.fill();
    }

    // held item: small colored square in the front hand
    if (o.held && !o.held.toLowerCase().startsWith("baby")) {
      const s = Math.max(3, H * 0.13);
      ctx.fillStyle = `hsl(${hashStr(o.held) % 360}, 55%, 60%)`;
      ctx.fillRect(handX - s / 2, handY - s / 2, s, s);
      ctx.strokeStyle = "rgba(0,0,0,0.5)";
      ctx.lineWidth = 1;
      ctx.strokeRect(handX - s / 2, handY - s / 2, s, s);
    }

    // head
    ctx.beginPath();
    ctx.arc(headX, headY, headR, 0, Math.PI * 2);
    ctx.fillStyle = skin;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.45)";
    ctx.stroke();
    // hair cap (longer on women)
    ctx.beginPath();
    ctx.arc(headX, headY - headR * 0.15, headR * 1.02, Math.PI * 0.95, Math.PI * 2.05);
    ctx.fillStyle = hair;
    ctx.fill();
    if (o.female && o.age >= 3) {
      ctx.fillRect(headX - f * headR * 0.9, headY - headR * 0.3, headR * 0.7, headR * 1.9);
    }
  }

  // name label
  if (o.u >= 18) {
    ctx.font = `9px ${MONO_FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const ly = o.y - figureHeight(o.age, o.u) - o.u * 0.12;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(o.name, o.x, ly);
    ctx.fillStyle = "#f2f4f6";
    ctx.fillText(o.name, o.x, ly);
  }

  // held item name under the figure
  if (o.held && o.u >= 22 && o.age >= 3) {
    ctx.font = `8px ${MONO_FONT}`;
    ctx.textAlign = "center";
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
    ctx.strokeText(truncate(o.held, 18), o.x, o.y + 10);
    ctx.fillStyle = "rgba(215, 221, 227, 0.85)";
    ctx.fillText(truncate(o.held, 18), o.x, o.y + 10);
  }
}

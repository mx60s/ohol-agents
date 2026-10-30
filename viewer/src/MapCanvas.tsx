import { useEffect, useRef } from "react";
import type { MapCellTuple, PlayerView, RunEvent } from "./api-types";

export const BIOME_COLORS: Record<number, string> = {
  0: "#5a8f3c", // grassland
  1: "#4d5e3a", // swamp
  2: "#c9b458", // prairie
  3: "#8a7f73", // badlands
  4: "#dfe8ee", // tundra
  5: "#d9b77a", // desert
  6: "#2f6b2f", // jungle
};
export const UNKNOWN_BIOME = "#666666";

const MONO_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Stable color for an agent slot id. */
export function agentColor(agentId: string): string {
  let h = 0;
  for (let i = 0; i < agentId.length; i++) {
    h = (h * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 70%, 55%)`;
}

export interface FocusPoint {
  x: number;
  y: number;
  /** bump this to re-apply the same point */
  seq: number;
}

interface MapCanvasProps {
  cells: MapCellTuple[];
  names: Record<number, string>;
  players: PlayerView[];
  recentSays: RunEvent[];
  follow: boolean;
  followTarget: { x: number; y: number } | null;
  focus: FocusPoint | null;
  onUserPan: () => void;
  onToggleFollow: () => void;
}

interface Camera {
  x: number;
  y: number;
  zoom: number;
  initialized: boolean;
}

function roundRectPath(
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

export default function MapCanvas(props: MapCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const camRef = useRef<Camera>({ x: 0, y: 0, zoom: 22, initialized: false });
  const sizeRef = useRef({ w: 300, h: 150 });
  const dragRef = useRef<{ px: number; py: number; moved: boolean } | null>(
    null,
  );

  // one-shot "center on this agent"
  const focusSeq = props.focus?.seq ?? 0;
  useEffect(() => {
    const f = propsRef.current.focus;
    if (f) {
      camRef.current.x = f.x;
      camRef.current.y = f.y;
      camRef.current.initialized = true;
    }
  }, [focusSeq]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ro = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      sizeRef.current = { w: rect.width, h: rect.height };
    });
    ro.observe(canvas);

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cam = camRef.current;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const { w, h } = sizeRef.current;
      // world point under cursor stays fixed while zooming (y axis flipped)
      const wx = cam.x + (mx - w / 2) / cam.zoom;
      const wy = cam.y - (my - h / 2) / cam.zoom;
      cam.zoom = Math.min(80, Math.max(2, cam.zoom * Math.exp(-e.deltaY * 0.0015)));
      cam.x = wx - (mx - w / 2) / cam.zoom;
      cam.y = wy + (my - h / 2) / cam.zoom;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    let raf = 0;
    const render = () => {
      raf = requestAnimationFrame(render);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const p = propsRef.current;
      const cam = camRef.current;
      const { w, h } = sizeRef.current;
      if (w <= 0 || h <= 0) return;

      // camera: initial jump + follow easing
      if (!cam.initialized && p.followTarget) {
        cam.x = p.followTarget.x;
        cam.y = p.followTarget.y;
        cam.initialized = true;
      }
      if (p.follow && p.followTarget) {
        cam.x += (p.followTarget.x - cam.x) * 0.08;
        cam.y += (p.followTarget.y - cam.y) * 0.08;
      }

      const dpr = window.devicePixelRatio || 1;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#0b0e11";
      ctx.fillRect(0, 0, w, h);

      const zoom = cam.zoom;
      // world -> screen; OHOL y grows north, screen y grows south: flip it
      const toSX = (wx: number) => w / 2 + (wx - cam.x) * zoom;
      const toSY = (wy: number) => h / 2 - (wy - cam.y) * zoom;

      const viewL = cam.x - w / 2 / zoom - 1;
      const viewR = cam.x + w / 2 / zoom + 1;
      const viewB = cam.y - h / 2 / zoom - 1;
      const viewT = cam.y + h / 2 / zoom + 1;

      // ---- map cells ----
      for (const [x, y, biome, floorId, objectId] of p.cells) {
        if (x < viewL || x > viewR || y < viewB || y > viewT) continue;
        const sx = toSX(x - 0.5);
        const sy = toSY(y + 0.5);
        ctx.fillStyle = BIOME_COLORS[biome] ?? UNKNOWN_BIOME;
        ctx.fillRect(sx, sy, zoom + 1, zoom + 1);
        if (floorId > 0) {
          ctx.fillStyle = "rgba(122, 74, 32, 0.4)";
          ctx.fillRect(sx, sy, zoom + 1, zoom + 1);
        }
        if (objectId > 0) {
          const s = Math.max(3, zoom * 0.36);
          const cx = toSX(x);
          const cy = toSY(y);
          ctx.fillStyle = "#15181c";
          ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
          if (zoom >= 28) {
            const raw = p.names[objectId];
            if (raw) {
              const base = raw.split("#")[0].trim();
              const label = base.length > 12 ? `${base.slice(0, 11)}…` : base;
              ctx.font = `9px ${MONO_FONT}`;
              ctx.textAlign = "center";
              ctx.textBaseline = "alphabetic";
              ctx.fillStyle = "rgba(232, 236, 240, 0.85)";
              ctx.fillText(label, cx, cy - s / 2 - 3);
            }
          }
        }
      }

      if (p.cells.length === 0) {
        ctx.font = `13px ${MONO_FONT}`;
        ctx.textAlign = "center";
        ctx.fillStyle = "#7d8894";
        ctx.fillText("waiting for map data…", w / 2, h / 2);
      }

      // ---- speech bubbles (grouped per player, newest last) ----
      const saysByPlayer = new Map<number, RunEvent[]>();
      for (const ev of p.recentSays) {
        if (ev.playerId == null) continue;
        const arr = saysByPlayer.get(ev.playerId);
        if (arr) arr.push(ev);
        else saysByPlayer.set(ev.playerId, [ev]);
      }

      // ---- players ----
      for (const pl of p.players) {
        const sx = toSX(pl.x);
        const sy = toSY(pl.y);
        if (sx < -60 || sx > w + 60 || sy < -60 || sy > h + 60) continue;

        let r = Math.max(3, zoom * 0.4);
        if (pl.age < 3) r *= 0.6; // babies are smaller

        ctx.beginPath();
        ctx.arc(sx, sy, r, 0, Math.PI * 2);
        ctx.fillStyle = pl.agentId ? agentColor(pl.agentId) : "#8b949e";
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
        ctx.stroke();

        if (pl.dying) {
          ctx.beginPath();
          ctx.arc(sx, sy, r + 3, 0, Math.PI * 2);
          ctx.lineWidth = 2;
          ctx.strokeStyle = "#ff3b30";
          ctx.stroke();
        }

        const label = pl.name ?? pl.agentId ?? `#${pl.id}`;
        ctx.font = `11px ${MONO_FONT}`;
        ctx.textAlign = "center";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
        ctx.strokeText(label, sx, sy - r - 6);
        ctx.fillStyle = "#f2f4f6";
        ctx.fillText(label, sx, sy - r - 6);

        // speech bubbles above the name, stacked upward, newest on the bottom
        const says = saysByPlayer.get(pl.id);
        if (says && says.length > 0) {
          const stack = says.slice(-3);
          let by = sy - r - 22;
          ctx.font = `10px ${MONO_FONT}`;
          for (let i = stack.length - 1; i >= 0; i--) {
            let text = stack[i].text;
            if (text.length > 42) text = `${text.slice(0, 41)}…`;
            const tw = ctx.measureText(text).width;
            const bw = tw + 12;
            const bh = 15;
            const bx = Math.min(Math.max(sx - bw / 2, 2), w - bw - 2);
            ctx.fillStyle = "rgba(238, 240, 234, 0.95)";
            roundRectPath(ctx, bx, by - bh, bw, bh, 4);
            ctx.fill();
            ctx.fillStyle = "#14161a";
            ctx.textAlign = "left";
            ctx.fillText(text, bx + 6, by - bh + 11);
            by -= bh + 3;
          }
        }
      }
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("wheel", onWheel);
    };
  }, []);

  return (
    <div className="map-wrap">
      <canvas
        ref={canvasRef}
        className="map-canvas"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { px: e.clientX, py: e.clientY, moved: false };
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (!d) return;
          const dx = e.clientX - d.px;
          const dy = e.clientY - d.py;
          if (!d.moved && Math.abs(dx) + Math.abs(dy) < 3) return;
          if (!d.moved) {
            d.moved = true;
            propsRef.current.onUserPan();
          }
          const cam = camRef.current;
          cam.x -= dx / cam.zoom;
          cam.y += dy / cam.zoom; // y flipped: dragging down moves view north
          cam.initialized = true;
          d.px = e.clientX;
          d.py = e.clientY;
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
      />
      <button
        type="button"
        className={`follow-btn${props.follow ? " active" : ""}`}
        onClick={props.onToggleFollow}
        title="Auto-follow the centroid of living agents"
      >
        {props.follow ? "● Following" : "Follow"}
      </button>
    </div>
  );
}

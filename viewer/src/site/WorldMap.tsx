// The world map from /api/map (every tile any agent has seen), drawn with the real OHOL art.
// Zoomed out: biome-coloured tiles. Zoomed in: ground textures + object sprites + people.
// Drag to pan, wheel (or the buttons) to zoom. Click a person to open their page.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MapCellTuple, PlayerView } from "../api-types.ts";
import { pageHref, useMap, useWorldState } from "../data/index.ts";
import { appearanceFor, drawGround, drawObject, drawPerson, getOholAssets, loadOholAssets, onOholSpriteLoaded } from "../ohol/index.ts";
import { displayName, firstNameOf } from "../shared/index.ts";
import type { SiteData } from "./useSite.ts";

import { BIOME_FILL, UNKNOWN_FILL } from "./logic.ts";

export { BIOME_FILL };

/** px per tile above which we draw textures and sprites */
const ART_ZOOM = 18;
const MIN_ZOOM = 1.5;
const MAX_ZOOM = 96;

interface View {
  cx: number; // world x at the canvas centre
  cy: number; // world y at the canvas centre (y up)
  z: number; // px per tile
}

interface Marker {
  p: PlayerView;
  sx: number;
  sy: number;
  r: number;
}

const key = (x: number, y: number) => `${x},${y}`;

export function WorldMap({ site, height = 360, focusLifeId }: { site: SiteData; height?: number; focusLifeId?: string | null }) {
  const map = useMap();
  const w = useWorldState();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 400, h: height });
  // null = auto-fit (follows the data) until the user pans or zooms
  const [userView, setView] = useState<View | null>(null);
  const [artReady, setArtReady] = useState(() => getOholAssets() != null);
  const [hoverName, setHoverName] = useState<{ name: string; x: number; y: number } | null>(null);
  const markers = useRef<Marker[]>([]);
  const drag = useRef<{ x: number; y: number; v: View; moved: boolean } | null>(null);
  const raf = useRef(0);

  const cells = map.data?.cells;
  const players = w.state?.players;

  const index = useMemo(() => {
    const m = new Map<string, MapCellTuple>();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const c of cells ?? []) {
      m.set(key(c[0], c[1]), c);
      if (c[0] < x0) x0 = c[0];
      if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1];
      if (c[1] > y1) y1 = c[1];
    }
    return { m, bbox: m.size ? { x0, x1, y0, y1 } : null };
  }, [cells]);

  useEffect(() => {
    if (artReady) return;
    loadOholAssets()
      .then(() => setArtReady(true))
      .catch(() => {});
  }, [artReady]);

  // size to the container
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: Math.max(200, el.clientWidth), h: height }));
    ro.observe(el);
    setSize({ w: Math.max(200, el.clientWidth), h: height });
    return () => ro.disconnect();
  }, [height]);

  const fit = useCallback((): View | null => {
    const b = index.bbox;
    const ours = (players ?? []).filter((p) => p.lifeId);
    if (!b && !ours.length) return null;
    const focus = focusLifeId ? ours.find((p) => p.lifeId === focusLifeId) : null;
    if (focus) return { cx: focus.x, cy: focus.y, z: 28 };
    const xs = [...(b ? [b.x0, b.x1] : []), ...ours.map((p) => p.x)];
    const ys = [...(b ? [b.y0, b.y1] : []), ...ours.map((p) => p.y)];
    const bx0 = Math.min(...xs), bx1 = Math.max(...xs), by0 = Math.min(...ys), by1 = Math.max(...ys);
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM / 4, Math.min(size.w / (bx1 - bx0 + 3), size.h / (by1 - by0 + 3))));
    return { cx: (bx0 + bx1) / 2, cy: (by0 + by1) / 2, z };
  }, [index.bbox, players, size.w, size.h, focusLifeId]);

  const autoView = useMemo(() => fit(), [fit]);
  const view = userView ?? autoView;

  const viewRef = useRef<View | null>(null);
  viewRef.current = view;

  const draw = useCallback(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = size.w, H = size.h;
    if (cv.width !== Math.round(W * dpr)) cv.width = Math.round(W * dpr);
    if (cv.height !== Math.round(H * dpr)) cv.height = Math.round(H * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = UNKNOWN_FILL;
    g.fillRect(0, 0, W, H);
    const v = view;
    if (!v) return;
    const z = v.z;
    const toSX = (x: number) => (x - v.cx) * z + W / 2;
    const toSY = (y: number) => (v.cy - y) * z + H / 2;
    const vx0 = Math.floor(v.cx - W / 2 / z) - 1, vx1 = Math.ceil(v.cx + W / 2 / z) + 1;
    const vy0 = Math.floor(v.cy - H / 2 / z) - 1, vy1 = Math.ceil(v.cy + H / 2 / z) + 1;
    const art = artReady && z >= ART_ZOOM && getOholAssets() != null;

    // visible cells
    const vis: MapCellTuple[] = [];
    if ((vx1 - vx0) * (vy1 - vy0) < index.m.size) {
      for (let y = vy1; y >= vy0; y--) for (let x = vx0; x <= vx1; x++) {
        const c = index.m.get(key(x, y));
        if (c) vis.push(c);
      }
    } else {
      for (const c of index.m.values()) if (c[0] >= vx0 && c[0] <= vx1 && c[1] >= vy0 && c[1] <= vy1) vis.push(c);
      vis.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    }

    // ground
    for (const [x, y, biome] of vis) {
      const sx = toSX(x) - z / 2, sy = toSY(y) - z / 2;
      if (!art || !drawGround(g, biome, x, y, sx, sy, z + 0.6)) {
        g.fillStyle = BIOME_FILL[biome] ?? UNKNOWN_FILL;
        g.fillRect(sx, sy, z + 0.6, z + 0.6);
      }
    }
    // floors + objects, north to south so southern things overlap
    const scale = z / 128;
    for (const [x, y, , floorId, objectId] of vis) {
      const ox = toSX(x), oy = toSY(y);
      if (art) {
        if (floorId > 0) drawObject(g, floorId, ox, oy, scale);
        if (objectId > 0) drawObject(g, objectId, ox, oy, scale);
      } else if (objectId > 0 && z >= 4) {
        g.fillStyle = "rgba(31,26,20,.55)";
        const s = Math.max(1.5, z * 0.32);
        g.fillRect(ox - s / 2, oy - s / 2, s, s);
      }
    }

    // people
    const ms: Marker[] = [];
    const ppl = [...(players ?? [])].sort((a, b) => b.y - a.y);
    for (const p of ppl) {
      const sx = toSX(p.x), sy = toSY(p.y);
      if (sx < -40 || sx > W + 40 || sy < -60 || sy > H + 40) continue;
      const life = p.lifeId ? site.byId[p.lifeId] : undefined;
      if (art) {
        const lineageId = life?.lineageId ?? p.lineageId ?? null;
        const female = life?.female ?? p.female ?? true;
        const appearance = lineageId
          ? appearanceFor({
              displayId: p.displayId,
              female,
              lineageId,
              traits: life?.traits ?? {},
              traitDims: site.dims,
              livingLineageIds: site.order,
              lifeId: p.lifeId ?? null,
              flower: p.flower ?? (p.lifeId ? site.flowerOf(p.lifeId) : null),
            })
          : null;
        const did = getOholAssets()?.manifest.objects[p.displayId]?.person ? p.displayId : female ? 19 : 347;
        drawPerson(g, { displayId: did, age: Math.max(0, Math.min(60, p.age)), facingLeft: false, heldObjectId: null, appearance }, sx, sy + z * 0.3, scale);
        ms.push({ p, sx, sy: sy - z * 0.45, r: Math.max(10, z * 0.55) });
      } else {
        const r = Math.max(4, Math.min(7, z * 0.9));
        g.beginPath();
        g.arc(sx, sy, r, 0, Math.PI * 2);
        g.fillStyle = p.lifeId ? "#fffdf7" : "#c9b88f";
        g.fill();
        g.lineWidth = 2;
        g.strokeStyle = "#1f1a14";
        g.stroke();
        if (p.lifeId && life?.status === "alive") {
          g.beginPath();
          g.arc(sx, sy, r * 0.42, 0, Math.PI * 2);
          g.fillStyle = "#1f1a14";
          g.fill();
        }
        ms.push({ p, sx, sy, r: r + 4 });
      }
      if (p.lifeId && focusLifeId === p.lifeId) {
        g.beginPath();
        g.arc(sx, art ? sy - z * 0.3 : sy, art ? z * 0.9 : 13, 0, Math.PI * 2);
        g.setLineDash([4, 3]);
        g.lineWidth = 2;
        g.strokeStyle = "#f4d77e";
        g.stroke();
        g.setLineDash([]);
      }
    }
    // name labels (ours only)
    g.font = "700 11px Lexend, system-ui, sans-serif";
    g.textAlign = "center";
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (const mk of ms) {
      if (!mk.p.lifeId) continue;
      const nm = shortName(mk.p.name, site.byId[mk.p.lifeId]?.name);
      if (!nm) continue;
      const ty = art ? mk.sy - z * 0.75 : mk.sy - mk.r - 3;
      // skip a label that would overprint one already drawn (people standing together, babies held)
      const tw = g.measureText(nm).width / 2 + 2;
      const box = { x0: mk.sx - tw, x1: mk.sx + tw, y0: ty - 11, y1: ty + 2 };
      if (placed.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) continue;
      placed.push(box);
      g.lineWidth = 3.5;
      g.strokeStyle = "rgba(255,253,247,.92)";
      g.strokeText(nm, mk.sx, ty);
      g.fillStyle = "#1f1a14";
      g.fillText(nm, mk.sx, ty);
    }
    markers.current = ms;
  }, [size, view, index, artReady, players, site.byId, site.dims, site.order, focusLifeId]);

  useEffect(() => {
    draw();
    return onOholSpriteLoaded(() => {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(draw);
    });
  }, [draw]);

  // wheel zoom (non-passive so the page doesn't scroll)
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = cv.getBoundingClientRect();
      setView((v) => {
        const base = v ?? viewRef.current;
        return base ? zoomAt(base, Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top, size.w, size.h) : base;
      });
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [size.w, size.h]);

  const hit = (mx: number, my: number): Marker | null => {
    let best: Marker | null = null;
    let bd = Infinity;
    for (const mk of markers.current) {
      const d = Math.hypot(mk.sx - mx, mk.sy - my);
      if (d <= mk.r && d < bd && mk.p.lifeId) {
        best = mk;
        bd = d;
      }
    }
    return best;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!view) return;
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, v: view, moved: false };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    const r = e.currentTarget.getBoundingClientRect();
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved) setView({ ...d.v, cx: d.v.cx - dx / d.v.z, cy: d.v.cy + dy / d.v.z });
      return;
    }
    const mk = hit(e.clientX - r.left, e.clientY - r.top);
    e.currentTarget.style.cursor = mk ? "pointer" : "grab";
    setHoverName(mk ? { name: displayName(site.byId[mk.p.lifeId ?? ""]?.name ?? mk.p.name), x: mk.sx, y: mk.sy } : null);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current;
    drag.current = null;
    if (d && !d.moved) {
      const r = e.currentTarget.getBoundingClientRect();
      const mk = hit(e.clientX - r.left, e.clientY - r.top);
      if (mk?.p.lifeId) window.location.href = pageHref("agent", { life: mk.p.lifeId });
    }
  };

  const empty = !index.m.size && !(players ?? []).length;
  return (
    <div className="wmap" ref={wrapRef} style={{ height }}>
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, touchAction: "none" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverName(null)}
        role="img"
        aria-label="World map. Drag to pan, scroll to zoom, click a person to open their page."
      />
      {empty && <div className="wmap-empty">{map.loading ? "Loading the map…" : map.error ? "Can't load the map right now." : "Nothing explored yet."}</div>}
      {hoverName && (
        <div className="wmap-tip ugc" style={{ left: hoverName.x, top: hoverName.y }}>
          {hoverName.name}
        </div>
      )}
      <div className="wmap-ctl">
        <button type="button" aria-label="Zoom in" onClick={() => setView(() => (view ? zoomAt(view, 1.6, size.w / 2, size.h / 2, size.w, size.h) : null))}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => setView(() => (view ? zoomAt(view, 1 / 1.6, size.w / 2, size.h / 2, size.w, size.h) : null))}>
          −
        </button>
        <button type="button" aria-label="Reset view" onClick={() => setView(null)}>
          ⟲
        </button>
      </div>
    </div>
  );
}

function zoomAt(v: View, f: number, mx: number, my: number, W: number, H: number): View {
  const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.z * f));
  // keep the world point under the cursor fixed
  const wx = v.cx + (mx - W / 2) / v.z;
  const wy = v.cy - (my - H / 2) / v.z;
  return { z, cx: wx - (mx - W / 2) / z, cy: wy + (my - H / 2) / z };
}

function shortName(live: string | null, rec: string | null | undefined): string {
  const n = displayName(rec ?? live, "");
  if (!n) return "";
  const first = Array.from(firstNameOf(n));
  return first.length > 12 ? `${first.slice(0, 11).join("")}…` : first.join("");
}

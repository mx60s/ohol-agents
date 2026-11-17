// Small React components matching the approved design (design/*.html). Styles: tokens.css, site.css, components.css.
// All text props render as React text (escaped); never inject raw HTML.

import { useEffect, type CSSProperties, type ReactNode } from "react";
import { pageHref, type SitePage } from "../data/config.ts";
import { getClient } from "../data/client.ts";
import { useNow, useWorldState } from "../data/hooks.ts";
import { formatClock, formatDuration, formatRelative } from "../shared/format.ts";
import { thinkingLabel, thinkingState } from "../shared/runStatus.ts";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ------------------------------------------------------------------ Panel

export type PanelVariant = "navy" | "green" | "orange" | "pink" | "yellow" | "dark" | "berry" | "mint";
const BAR: Record<PanelVariant, string> = {
  navy: "is-navy",
  green: "is-leaf",
  orange: "is-clay",
  pink: "is-bubblegum",
  yellow: "is-butter",
  dark: "is-ink",
  berry: "is-berry",
  mint: "is-mint",
};

export interface PanelProps {
  title: ReactNode;
  /** small right-aligned text in the title bar */
  sub?: ReactNode;
  variant?: PanelVariant;
  /** extra element(s) right after the title (e.g. <MockBadge />) */
  badge?: ReactNode;
  children?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** skip the padded body wrapper (for full-bleed content) */
  bare?: boolean;
  id?: string;
  style?: CSSProperties;
}

/** Parchment panel with a glossy title bar. */
export function Panel({ title, sub, variant = "navy", badge, children, className, bodyClassName, bare, id, style }: PanelProps) {
  return (
    <section className={cx("panel", className)} id={id} style={style}>
      <div className={cx("panel-head", BAR[variant])}>
        <span className="ttl">{title}</span>
        {badge}
        {sub != null && <span className="sub">{sub}</span>}
      </div>
      {bare ? children : <div className={cx("panel-body", bodyClassName)}>{children}</div>}
    </section>
  );
}

// ------------------------------------------------------------------ StatTile

export interface StatTileProps {
  value: ReactNode;
  /** small text after the number, e.g. "/ 23" or "y" */
  suffix?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  tone?: "good" | "bad";
  className?: string;
}

/** Big number + caps label + muted detail. Put several in <div className="tiles"> for the dashed grid. */
export function StatTile({ value, suffix, label, detail, tone, className }: StatTileProps) {
  return (
    <div className={cx("stat", tone, className)}>
      <span className="n">
        {value}
        {suffix != null && <> <small>{suffix}</small></>}
      </span>
      <span className="k">{label}</span>
      {detail != null && <span className="d">{detail}</span>}
    </div>
  );
}

/** Dashed grid of StatTiles, `cols` per row. */
export function StatTiles({ cols = 4, children }: { cols?: number; children: ReactNode }) {
  return (
    <div className="tiles" style={{ "--tile-cols": cols } as CSSProperties}>
      {children}
    </div>
  );
}

// ------------------------------------------------------------------ stickers & badges

export interface StickerProps {
  children: ReactNode;
  variant?: "butter" | "mock" | "live";
  /** px (square); default 78 */
  size?: number;
  /** degrees; default -10 */
  rotate?: number;
  className?: string;
  style?: CSSProperties;
}

/** Starburst sticker ("GEN 3 REACHED!", "LIVE!", "MOCK"). */
export function Sticker({ children, variant = "butter", size, rotate, className, style }: StickerProps) {
  return (
    <div
      className={cx("burst", variant === "mock" && "is-mock", variant === "live" && "is-live", className)}
      style={{ ...(size ? { width: size, height: size } : {}), ...(rotate != null ? { transform: `rotate(${rotate}deg)` } : {}), ...style }}
    >
      <span>{children}</span>
    </div>
  );
}

/** Small MOCK tag. Use ONE per place trait numbers are shown (cloud, agent personality, study charts); site only, not the stream. */
export function MockBadge({ title = "Mock: random traits, not read from the model's neurons yet", label = "MOCK" }: { title?: string; label?: string }) {
  return (
    <span className="mock-tag" title={title}>
      {label}
    </span>
  );
}

export type PillTone = "alive" | "dead" | "danger" | "warn" | "navy";
export function Pill({ tone, children, title }: { tone?: PillTone; children: ReactNode; title?: string }) {
  return (
    <span className={cx("pill", tone)} title={title}>
      {children}
    </span>
  );
}

export type ButtonVariant = "berry" | "leaf" | "clay" | "butter" | "ghost";
export function Button({ href, variant = "berry", children, onClick, className }: { href?: string; variant?: ButtonVariant; children: ReactNode; onClick?: () => void; className?: string }) {
  const c = cx("btn", variant !== "berry" && `is-${variant}`, className);
  return href ? (
    <a className={c} href={href} onClick={onClick}>
      {children}
    </a>
  ) : (
    <button type="button" className={c} onClick={onClick}>
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ wordmark, nav, header, footer

export const SITE_NAME = "Artificial Selection";

/** Bubble-letter wordmark ("Artificial Selection"). */
export function Wordmark({ size, text = SITE_NAME }: { size?: "sm" | "md" | "lg"; text?: string }) {
  return (
    <span className={cx("wordmark", size === "sm" && "is-sm", size === "lg" && "is-lg")} aria-label={text}>
      {Array.from(text).map((ch, i) => (ch === " " ? <span key={i} className="sp" aria-hidden /> : <span key={i} aria-hidden>{ch}</span>))}
    </span>
  );
}

export type NavKey = "live" | "people" | "families" | "agents" | "study" | "about";
export const NAV_ITEMS: { key: NavKey; label: string; page: SitePage; hash?: string }[] = [
  { key: "live", label: "Live", page: "home" },
  { key: "people", label: "People", page: "people" },
  { key: "families", label: "Families", page: "families" },
  { key: "agents", label: "How agents work", page: "agents" },
  { key: "study", label: "Study", page: "study" },
  { key: "about", label: "About", page: "about" },
];

/** Segmented glossy nav. Links keep ?fixture= / ?api=. */
export function NavBar({ active }: { active?: NavKey }) {
  return (
    <nav className="navbar" aria-label="Site">
      {NAV_ITEMS.map((n) => (
        <a key={n.key} className={n.key === active ? "on" : undefined} href={pageHref(n.page, {}, n.hash)} aria-current={n.key === active ? "page" : undefined}>
          {n.label}
        </a>
      ))}
    </nav>
  );
}

export function SiteHeader({ active, tagline = "How personality shapes a society of AI people in One Hour One Life" }: { active?: NavKey; tagline?: string | null }) {
  return (
    <header className="site-top">
      <div className="in">
        <a className="wordmark-link" href={pageHref("home")}>
          <Wordmark />
        </a>
        {tagline && <div className="tagline">{tagline}</div>}
        <NavBar active={active} />
        <a className="btn is-clay watch" href={pageHref("stream")}>
          ▶ Watch the stream
        </a>
      </div>
    </header>
  );
}

/** "google/gemini-3.8-flash" -> "Gemini 3.8 Flash" */
export function prettyModel(model: string): string {
  return model
    .replace(/^[^/]+\//, "")
    .split(/[-_\s]+/)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Status strip under the header: live/offline, started, model + agent count, last update. */
export function RunBar() {
  const w = useWorldState();
  const now = useNow(1000);
  const run = w.state?.run;
  const snapshot = getClient().isStatic;
  const status = snapshot ? "SNAPSHOT" : w.connection === "offline" ? "OFFLINE" : w.connection === "connecting" ? "CONNECTING" : run?.status === "paused" ? "PAUSED" : run?.status === "halted" ? "ENDED" : run?.status === "idle" ? "IDLE" : "LIVE";
  const live = status === "LIVE";
  const agents = w.state?.agents.length ?? 0;
  // paused for a provider outage / the spend cap, or provider calls failing: say so, with how long
  const thinking = snapshot ? { kind: "ok" as const } : thinkingState(run);
  const pause = thinkingLabel(thinking, formatDuration, now);
  const pauseTitle = thinking.kind === "daily-cap" ? (run?.pauseReason ?? undefined) : thinking.kind !== "ok" ? (run?.llmStatus?.lastError ?? undefined) : undefined;
  return (
    <div className="runbar">
      <div className="in">
        <span className={cx("live", "conn", w.connection === "offline" && "offline")} title={w.error?.message}>
          <span className={cx("live-dot", !live && "off")} />
          <b>{status}</b>
        </span>
        {pause && (
          <span className={cx("pause", thinking.kind !== "daily-cap" && "is-provider")} title={pauseTitle} role="status">
            {pause}
          </span>
        )}
        {run && (
          <>
            <span>
              Started <b>{formatClock(run.startedAt)}</b> · running <b>{formatDuration(now - run.startedAt)}</b>
            </span>
            <span className="sep" />
            <span>
              Agents: <b>{agents}</b> · <b>{prettyModel(run.model)}</b>
            </span>
            {!snapshot && <span className="sep" />}
          </>
        )}
        {!snapshot && (
          <span>
            Last update <b>{w.lastUpdate ? formatRelative(Math.min(w.lastUpdate, now), now) : "never"}</b>
          </span>
        )}
      </div>
    </div>
  );
}

export const ART_CREDIT = "Game art: One Hour One Life, by Jason Rohrer (public domain). Not affiliated with or endorsed by Jason Rohrer.";

export function Footer({ disclaimer = null }: { disclaimer?: string | null }) {
  return (
    <footer className="footer">
      <div className="in">
        <span>{SITE_NAME} · a research pilot on agent societies</span>
        <span className="credit">{ART_CREDIT}</span>
        {disclaimer && <span className="disclaimer">{disclaimer}</span>}
      </div>
    </footer>
  );
}

/**
 * Links like families.html#deaths point at panels that only render once data has loaded, after
 * the browser has already given up on the hash. Scroll to the target when it appears (once,
 * within a few seconds, and not if the reader has scrolled meanwhile).
 */
function useLateHashScroll() {
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    let done = false;
    const tryScroll = () => {
      if (done) return;
      const el = document.getElementById(id);
      if (!el) return;
      done = true;
      if (window.scrollY < 40) el.scrollIntoView({ block: "start" });
      stop();
    };
    const mo = new MutationObserver(tryScroll);
    mo.observe(document.body, { childList: true, subtree: true });
    const t = setTimeout(() => stop(), 8000);
    function stop() {
      mo.disconnect();
      clearTimeout(t);
    }
    tryScroll();
    return stop;
  }, []);
}

/** Header + run bar + <main className="page"> + footer. */
export function SiteLayout({ active, children, runbar = true, wide }: { active?: NavKey; children: ReactNode; runbar?: boolean; wide?: boolean }) {
  useLateHashScroll();
  return (
    <>
      <SiteHeader active={active} />
      {runbar && <RunBar />}
      <main className="page" style={wide ? { maxWidth: "none" } : undefined}>
        {children}
      </main>
      <Footer />
    </>
  );
}

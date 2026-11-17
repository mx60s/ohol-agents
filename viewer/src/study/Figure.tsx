import type { ReactNode } from "react";
import { Panel, type PanelVariant } from "../theme/index.ts";

/** A study figure: panel + title line with n + chart + one mono stats line. */
export function Figure({ head, title, n, foot, variant, className, children }: {
  head: ReactNode;
  title?: ReactNode;
  n: ReactNode;
  foot?: ReactNode;
  variant: PanelVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Panel title={head} variant={variant} className={`figure ${className ?? ""}`}>
      <div className="chart-head">
        {title && <h3>{title}</h3>}
        <span className="n">{n}</span>
      </div>
      {children}
      {foot && <div className="foot">{foot}</div>}
    </Panel>
  );
}

export function Ribbon({ q, children }: { q: string; children: ReactNode }) {
  return (
    <div className="ribbon q-ribbon">
      <span className="qn">{q}</span> {children}
    </div>
  );
}

// The camera's chat box: what the people on screen said lately, as a transcript (newest at the
// bottom). Names wear the speaker's hair colour and flower, the same colour as their label and their
// "…" pip over the head in a crowd. Every piece of model text renders as escaped React text.

import type { Flower } from "../api-types.ts";
import { cueLabel, FlowerIcon } from "../shared/index.ts";
import { shortName, type ChatLine } from "./crowd.ts";

export function ChatBox({ lines, colorOf, flowerOf, focusPlayerId, docked }: { lines: ChatLine[]; colorOf: (playerId: number) => string | null; flowerOf: (playerId: number) => Flower | null; focusPlayerId: number | null; docked?: boolean }) {
  if (!lines.length) return null;
  const n = lines.length;
  return (
    <div className={`cam-chat${docked ? " is-docked" : ""}`} aria-label="what people nearby said">
      <ol>
        {lines.map((l, i) => {
          const color = colorOf(l.playerId);
          const flower = flowerOf(l.playerId);
          // older lines fade back a little; the newest three stay full strength
          const age = n - 1 - i;
          const opacity = age < 3 ? 1 : Math.max(0.5, 1 - (age - 2) * 0.09);
          return (
            <li key={l.key} className={`${l.emote ? "is-emote" : ""}${l.cross ? " is-cross" : ""}${l.playerId === focusPlayerId ? " is-focus" : ""}`} style={{ opacity, ...(color ? ({ "--who": color } as React.CSSProperties) : {}) }}>
              <span className="spk">
                {flower ? <FlowerIcon flower={flower} size={20} className="fl" /> : <span className="sw" aria-hidden="true" />}
                <b className="ugc">{shortName(l.name)}</b>
                {l.cross && l.family && <span className="fam ugc">{l.family}</span>}
              </span>{" "}
              {l.emote ? <span className="tx em">({cueLabel(l.emote)})</span> : <span className="tx ugc">{l.text}</span>}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

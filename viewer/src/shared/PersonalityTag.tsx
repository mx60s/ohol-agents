// A small pill with a family's prompted personality descriptor (see personality.ts). Renders
// nothing when there is none (feature off, older runs).

import { personalityShort, personalitySlot, personalityTitle } from "./personality.ts";

export function PersonalityTag({ personality, palette, short, className }: { personality: string | null | undefined; palette?: readonly string[] | null; short?: boolean; className?: string }) {
  if (!personality) return null;
  return (
    <span className={`pill persona p${personalitySlot(personality, palette)}${className ? ` ${className}` : ""}`} title={personalityTitle(personality)}>
      {short ? personalityShort(personality) : personality}
    </span>
  );
}

// A "say" event whose whole text is a +WORD+ cue ("+HOMESICK+", "+HOME+") is
// the server's emote over a character's head (Agent onCue), not speech: the
// stream draws it as an emote; speech counts, notes and narration skip it.

const CUE_SAY = /^\s*\+([A-Z](?:[A-Z ]*[A-Z])?)\+\s*$/;

/** "HOMESICK" for "+HOMESICK+"; null for real speech */
export function cueOfSay(text: string | null | undefined): string | null {
  const m = CUE_SAY.exec(text ?? "");
  return m ? m[1] : null;
}

// Real OHOL art for the viewer: asset loading + canvas drawing (render.ts), agent looks (appearance.ts).
export * from "./render.ts";
export * from "./appearance.ts";
export { composeObject, composePerson, personLayers, NUDITY_SPRITES } from "./compose.ts";
export type { DrawOp, PersonSpec, ObjectOpts } from "./compose.ts";
export type * from "./types.ts";

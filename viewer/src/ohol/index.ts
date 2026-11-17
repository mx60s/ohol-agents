// Real OHOL art for the viewer: asset loading + canvas drawing (render.ts), agent looks (appearance.ts).
export * from "./render.ts";
export * from "./appearance.ts";
export { composeObject, composePerson, opsBounds, personLayers, NUDITY_SPRITES, FLOWER_SPOT } from "./compose.ts";
export type { Box, DrawOp, PersonSpec, ObjectOpts } from "./compose.ts";
export type * from "./types.ts";
export { FLOWER_ART, flowerFor, flowerHex, flowerSizeAtAge } from "./flower.ts";
export type { Flower, FlowerInput } from "./flower.ts";
export { FLOWER_COLORS, FLOWER_SHAPES, flowerLabel } from "../flowers.ts";

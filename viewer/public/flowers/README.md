# Generated flower sprites

The six per-person flower shapes that are not real One Hour One Life sprites: `daisy.png`,
`tulip.png`, `poppy.png`, `iris.png`, `lily.png`, `forgetmenot.png`.

AI-generated with gpt-5.4-image-2 via OpenRouter, 2026-11-17, in the style of OHOL art (the
prompt included a reference sheet of OHOL sprites). Variant "gpt-b1" of each shape, chosen by
hand.

Processing: background removed, trimmed to the flower, scaled to 64 px on the longer side.
Petals are white or pale for tinting: the viewer recolours them per flower colour at runtime
(`src/ohol/flowerArt.ts`, `recolorFlowerPixels` in `src/ohol/flower.ts`), keeping the thick ink
outline and the yellow centres. The catalogue is `src/flowers.ts`.

These are not part of OneLifeData7 and are not covered by its licence notes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { coarseMap } from "./population.ts";

test("coarseMap: whole explored world, one sample per block, unknown biomes skipped", () => {
  const cells = new Map<string, { biome: number }>();
  for (let x = -50; x < 50; x++) for (let y = 0; y < 40; y++) cells.set(`${x},${y}`, { biome: x < 0 ? 1 : 2 });
  cells.set("500,500", { biome: 3 }); // a far traveller's tile
  cells.set("501,500", { biome: -1 });
  const small = coarseMap(cells, 1_000_000);
  assert.equal(small.block, 1);
  assert.equal(small.cells.length, 100 * 40 + 1);
  const c = coarseMap(cells, 500);
  assert.equal(c.block, Math.ceil(Math.sqrt(cells.size / 500)));
  assert.ok(c.cells.length <= 600, `${c.cells.length} samples`);
  assert.ok(c.cells.some(([x, y, b]) => b === 3 && x <= 500 && y <= 500), "far tiles are kept");
  assert.ok(c.cells.every(([x, y]) => x % c.block === 0 && y % c.block === 0));
});

// /api/stream limits and the control-token check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net, { type AddressInfo } from "node:net";
import type http from "node:http";
import { startApi, tokenMatches } from "./api.ts";
import type { RunController } from "./runs.ts";
import type { GameData } from "./game/gameData.ts";

function fakeRuns() {
  return Object.assign(new EventEmitter(), { lives: null, openControl: false }) as unknown as RunController & EventEmitter;
}

async function listen(server: http.Server) {
  if (!server.listening) await new Promise((r) => server.once("listening", r));
  return (server.address() as AddressInfo).port;
}

/** Opens /api/stream on a raw socket; resolves once the response head arrives. */
function openStream(port: number, read = true): Promise<{ sock: net.Socket; head: string }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write("GET /api/stream HTTP/1.1\r\nHost: x\r\n\r\n"));
    sock.once("data", (d) => {
      if (!read) sock.pause();
      resolve({ sock, head: d.toString().split("\r\n")[0] });
    });
    sock.on("error", reject);
  });
}

test("SSE clients are capped; a closed client frees its slot", async () => {
  const runs = fakeRuns();
  const server = startApi(0, runs, {} as GameData, "", { maxSseClients: 2 });
  const port = await listen(server);
  try {
    const a = await openStream(port);
    const b = await openStream(port);
    assert.match(a.head, /200/);
    assert.match(b.head, /200/);
    const c = await openStream(port);
    assert.match(c.head, /503/, "third client is refused");
    c.sock.destroy();
    a.sock.destroy();
    await new Promise((r) => setTimeout(r, 100));
    const d = await openStream(port);
    assert.match(d.head, /200/, "slot freed after close");
    b.sock.destroy();
    d.sock.destroy();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("a stalled SSE reader is dropped instead of buffering every event in memory", async () => {
  const runs = fakeRuns();
  const server = startApi(0, runs, {} as GameData, "", { sseMaxBufferBytes: 64 * 1024 });
  const port = await listen(server);
  try {
    const { sock } = await openStream(port, false); // never reads
    const conns = () => new Promise<number>((r) => server.getConnections((_e, n) => r(n)));
    assert.equal(await conns(), 1);
    const big = "x".repeat(16 * 1024);
    for (let i = 0; i < 2000; i++) {
      runs.emit("event", { seq: i, t: 0, kind: "system", agentId: null, playerId: null, name: null, text: big });
      if (i % 50 === 0) {
        await new Promise((r) => setTimeout(r, 5));
        if ((await conns()) === 0) break;
      }
    }
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await conns(), 0, "server dropped the stalled client");
    sock.destroy();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});

test("control token check is exact and constant-time", () => {
  assert.equal(tokenMatches("secret", "secret"), true);
  assert.equal(tokenMatches("secre", "secret"), false);
  assert.equal(tokenMatches("secret ", "secret"), false);
  assert.equal(tokenMatches("", ""), false, "no token configured = never authorized");
  assert.equal(tokenMatches("anything", ""), false);
});

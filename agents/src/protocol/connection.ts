// TCP connection to an OHOL server: framing, decompression, login.
//
// Wire format (see OneLife/server/protocol.txt):
//   text messages: "TAG\nline\nline\n#"
//   CM / MC: a text header ending in '#', followed by <compressed_size> bytes
//   of zlib data. CM wraps any other text message. MC is a map chunk.

import net from "node:net";
import { EventEmitter } from "node:events";
import { inflateSync } from "node:zlib";
import { createHmac } from "node:crypto";

export interface RawMessage {
  type: string;
  /** lines after the type tag, '#' terminator removed */
  lines: string[];
  /** decompressed payload for MC (map chunk) */
  binary?: Buffer;
}

export interface ConnectOptions {
  host: string;
  port: number;
  email: string;
  clientTag?: string;
  /** server access password; only checked if server requireClientPassword=1 */
  password?: string;
  accountKey?: string;
  /** RLOGIN = reconnect to an existing life only */
  reconnect?: boolean;
}

export type LoginResult = "ACCEPTED" | "REJECTED" | "NO_LIFE_TOKENS" | "SERVER_FULL" | "SHUTDOWN";

const hmac = (key: string, data: string) => createHmac("sha1", key).update(data).digest("hex");

export class Connection extends EventEmitter {
  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private keepAliveTimer: NodeJS.Timeout | null = null;
  closed = false;
  lastReceiveAt = 0;

  constructor(readonly opts: ConnectOptions) {
    super();
  }

  /** Connects and logs in. Resolves with the login result. */
  connect(timeoutMs = 15000): Promise<LoginResult> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.opts.host, port: this.opts.port });
      this.sock = sock;
      sock.setNoDelay(true);
      let settled = false;
      const done = (err: Error | null, res?: LoginResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.off("message", onMsg);
        if (err) reject(err);
        else resolve(res!);
      };
      const timer = setTimeout(() => done(new Error("login timeout")), timeoutMs);

      const onMsg = (m: RawMessage) => {
        if (m.type === "SN") {
          const challenge = m.lines[1] ?? "";
          const tag = this.opts.clientTag ?? "client_mts_agent";
          const pw = hmac(this.opts.password ?? "", challenge);
          const key = hmac((this.opts.accountKey ?? "NOKEY").toUpperCase().replace(/-/g, ""), challenge);
          const cmd = this.opts.reconnect ? "RLOGIN" : "LOGIN";
          this.send(`${cmd} ${tag} ${this.opts.email} ${pw} ${key} 0`);
        } else if (m.type === "ACCEPTED") {
          this.startKeepAlive();
          done(null, "ACCEPTED");
        } else if (m.type === "REJECTED" || m.type === "SERVER_FULL" || m.type === "SHUTDOWN" || m.type === "NO_LIFE_TOKENS") {
          done(null, m.type as LoginResult);
        }
      };
      this.on("message", onMsg);

      sock.on("data", (chunk) => this.onData(chunk as Buffer));
      sock.on("error", (e) => {
        this.emit("error", e);
        done(e);
      });
      sock.on("close", () => {
        this.closed = true;
        this.stopKeepAlive();
        this.emit("close");
        done(new Error("connection closed during login"));
      });
    });
  }

  send(cmd: string) {
    if (!this.sock || this.closed) return;
    this.emit("sent", cmd);
    this.sock.write(cmd.endsWith("#") ? cmd : cmd + "#");
  }

  close() {
    this.stopKeepAlive();
    this.sock?.destroy();
    this.closed = true;
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => this.send("KA 0 0"), 15000);
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  private onData(chunk: Buffer) {
    this.lastReceiveAt = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const m = this.tryParseOne();
      if (!m) break;
      if (m.type === "CM") continue; // handled inside tryParseOne
      this.emit("message", m);
    }
  }

  /** Parses one message off the front of the buffer, or returns null if incomplete. */
  private tryParseOne(): RawMessage | null {
    const hash = this.buf.indexOf(0x23); // '#'
    if (hash < 0) return null;
    const header = this.buf.subarray(0, hash).toString("latin1");
    const nl = header.indexOf("\n");
    const type = (nl < 0 ? header : header.slice(0, nl)).trim();

    if (type === "CM" || type === "MC") {
      const lines = header.split("\n").slice(1).filter((l) => l.length > 0);
      const sizeLine = type === "CM" ? lines[0] : lines[1];
      const [, compSizeStr] = (sizeLine ?? "").trim().split(/\s+/);
      const compSize = Number(compSizeStr);
      if (!Number.isFinite(compSize)) {
        // malformed; drop header to avoid getting stuck
        this.buf = this.buf.subarray(hash + 1);
        return { type: "BAD", lines };
      }
      if (this.buf.length < hash + 1 + compSize) return null;
      const comp = this.buf.subarray(hash + 1, hash + 1 + compSize);
      this.buf = this.buf.subarray(hash + 1 + compSize);
      const raw = inflateSync(comp);
      if (type === "MC") return { type, lines, binary: raw };
      // CM: payload is one or more ordinary text messages
      this.parseText(raw.toString("latin1"));
      return { type: "CM", lines };
    }

    this.buf = this.buf.subarray(hash + 1);
    return splitText(header);
  }

  private parseText(text: string) {
    for (const part of text.split("#")) {
      if (part.trim().length === 0) continue;
      this.emit("message", splitText(part));
    }
  }
}

function splitText(body: string): RawMessage {
  const lines = body.split("\n");
  while (lines.length && lines[0].trim() === "") lines.shift();
  const type = (lines.shift() ?? "").trim();
  return { type, lines: lines.filter((l) => l.length > 0) };
}

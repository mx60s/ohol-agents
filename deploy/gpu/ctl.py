"""Pod control server (port 8001). Token in env CTL_TOKEN, sent as header x-token.
GET  /health                      no auth
GET  /status                      current server job + nvidia-smi
GET  /log?name=X&n=200            tail of /logs/X.log (default: current server)
POST /run   {name, cmd}           stop current server job, start cmd (bash) in its own process group
POST /stop                        stop current server job
POST /bg    {name, cmd}           start a background job (does not touch the server job)
POST /sh    {cmd, timeout}        run synchronously, return output (last 20 KB)
"""
import http.server, json, os, signal, subprocess, time, urllib.parse

TOK = os.environ["CTL_TOKEN"]
LOG = "/logs"
os.makedirs(LOG, exist_ok=True)
cur = {"p": None, "name": None, "cmd": None, "t": None}
bg = {}


def gpu_pids():
    try:
        out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"], capture_output=True, text=True, timeout=20).stdout
        return [int(x) for x in out.split() if x.strip().isdigit()]
    except Exception:
        return []


def stop():
    p = cur["p"]
    if p and p.poll() is None:
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except Exception:
            pass
        for _ in range(40):
            if p.poll() is not None:
                break
            time.sleep(0.5)
        try:
            os.killpg(p.pid, signal.SIGKILL)
        except Exception:
            pass
    for pid in gpu_pids():
        try:
            os.kill(pid, signal.SIGKILL)
        except Exception:
            pass
    for _ in range(30):
        if not gpu_pids():
            break
        time.sleep(1)


def spawn(name, cmd):
    f = open(f"{LOG}/{name}.log", "ab")
    return subprocess.Popen(["bash", "-lc", cmd], stdout=f, stderr=subprocess.STDOUT, start_new_session=True)


def tail(path, n):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 200_000))
            lines = f.read().decode(errors="replace").splitlines()
        return "\n".join(lines[-n:])
    except Exception as e:
        return f"(no log: {e})"


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def out(self, code, obj):
        b = (obj if isinstance(obj, str) else json.dumps(obj)).encode()
        self.send_response(code)
        self.send_header("content-type", "text/plain" if isinstance(obj, str) else "application/json")
        self.send_header("content-length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def authed(self):
        if self.headers.get("x-token") != TOK:
            self.out(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == "/health":
            return self.out(200, "ok")
        if not self.authed():
            return
        if u.path == "/status":
            p = cur["p"]
            smi = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader"], capture_output=True, text=True).stdout
            return self.out(200, {"name": cur["name"], "running": bool(p and p.poll() is None), "rc": p.poll() if p else None,
                                  "uptime": round(time.time() - cur["t"]) if cur["t"] else None, "gpu": smi.strip(),
                                  "bg": {k: v.poll() for k, v in bg.items()}})
        if u.path == "/log":
            name = q.get("name") or cur["name"] or "none"
            return self.out(200, tail(f"{LOG}/{name}.log", int(q.get("n", 200))))
        self.out(404, {"error": "not found"})

    def do_POST(self):
        if not self.authed():
            return
        n = int(self.headers.get("content-length") or 0)
        body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/run":
            stop()
            cur.update(p=spawn(body["name"], body["cmd"]), name=body["name"], cmd=body["cmd"], t=time.time())
            return self.out(200, {"started": body["name"], "pid": cur["p"].pid})
        if self.path == "/stop":
            stop()
            return self.out(200, {"stopped": True})
        if self.path == "/bg":
            bg[body["name"]] = spawn(body["name"], body["cmd"])
            return self.out(200, {"bg": body["name"]})
        if self.path == "/sh":
            try:
                r = subprocess.run(["bash", "-lc", body["cmd"]], capture_output=True, text=True, timeout=float(body.get("timeout", 120)))
                return self.out(200, {"rc": r.returncode, "out": (r.stdout + r.stderr)[-20000:]})
            except subprocess.TimeoutExpired as e:
                return self.out(200, {"rc": -1, "out": f"timeout; partial: {str(e.stdout)[-5000:]}"})
        self.out(404, {"error": "not found"})


http.server.ThreadingHTTPServer(("0.0.0.0", 8001), H).serve_forever()

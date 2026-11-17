"""Derive per-slot-hour distributions from the measured agent logs. Writes measured.json.

Read-only over the repo. Usage: python3 analyze.py
"""
import json, re, collections, numpy as np

ROOT = "/Users/mvonebers/ohol-stream/agents/"
RUNS = {
    "dev1": ROOT + "logs-dev/dev1-r1-mwjtcz8f-2026-11-16T22-06-56-607Z/",
    "showcase1": ROOT + "logs/showcase1-r1-mvvlsrb7-2026-10-30T23-28-47-683Z/",
}
STORY = ROOT + "logs-dev/story.jsonl"
AGE = re.compile(r", age ([\d.]+)\)")
STAGES = ((0, 2, "baby"), (2, 14, "child"), (14, 999, "adult"))


def stage(a):
    return "baby" if a < 2 else ("child" if a < 14 else "adult")


def load(p):
    try:
        return [json.loads(l) for l in open(p)]
    except FileNotFoundError:
        return []


def q(x, ps=(5, 25, 50, 75, 95)):
    x = np.asarray(x, float)
    return {f"p{p}": float(np.percentile(x, p)) for p in ps} | {"mean": float(x.mean()), "n": int(len(x))}


out = {}
for name, D in RUNS.items():
    ev = load(D + "events.jsonl")
    llm = load(D + "llm.jsonl")
    # productive window ends at halt or the first "lost connection" (server went away)
    tend = next((e["t"] for e in ev if e["kind"] == "system" and ("halted" in e["text"] or "lost connection" in e["text"])), ev[-1]["t"])
    # ...or at the first 402 "Insufficient credits" (both runs ran out of OpenRouter credit mid-run)
    t402 = next((r["t"] for r in llm if "402" in r.get("error", "")), None)
    if t402: tend = min(tend, t402)
    agents = sorted({e["agentId"] for e in ev if e.get("agentId")})
    first = {a: min(e["t"] for e in ev if e.get("agentId") == a and e["kind"] == "birth") for a in agents}
    slot_h = sum((tend - first[a]) / 3.6e6 for a in agents)

    lives = []  # (agent, t_birth, t_end, age0, died)
    for a in agents:
        evs = [e for e in ev if e.get("agentId") == a and e["kind"] in ("birth", "death") and e["t"] <= tend]
        cur = None
        for e in evs:
            if e["kind"] == "birth":
                cur = e
            elif cur:
                lives.append((a, cur["t"], e["t"], 14.0 if cur["data"].get("eve") else cur["data"].get("age", 0), True))
                cur = None
        if cur:
            lives.append((a, cur["t"], tend, 14.0 if cur["data"].get("eve") else cur["data"].get("age", 0), False))
    stage_h = collections.Counter()
    alive_h = 0.0
    for a, tb, te, age0, _ in lives:
        dur_min = (te - tb) / 60000  # 1 year = 1 minute
        alive_h += dur_min / 60
        for lo, hi, s in STAGES:
            stage_h[s] += max(0, min(hi, age0 + dur_min) - max(lo, age0)) / 60
    # gaps between death and next birth on the same slot
    gaps = []
    for a in agents:
        L = sorted([l for l in lives if l[0] == a], key=lambda l: l[1])
        for x, y in zip(L, L[1:]):
            gaps.append((y[1] - x[2]) / 1000)

    ok = [r for r in llm if "promptTokens" in r and r["t"] <= tend]
    err = [r for r in llm if "error" in r and r["t"] <= tend]
    by_stage = collections.defaultdict(list)
    for r in ok:
        m = AGE.search(r.get("observation", ""))
        if m:
            by_stage[stage(float(m.group(1)))].append(r)
    calls_per_stage_h = {s: len(by_stage[s]) / stage_h[s] if stage_h[s] else None for s in ("baby", "child", "adult")}

    # per-slot-hour call rate in 15-min windows (for an empirical spread)
    win = 15 * 60000
    starts = np.arange(max(first.values()), tend - win, win)
    rates = [sum(1 for r in ok if s <= r["t"] < s + win) / (len(agents) * 0.25) for s in starts]
    # decision cycle time per agent (gap between consecutive calls within one life)
    cyc = collections.defaultdict(list)
    lastt = {}
    for r in sorted(ok, key=lambda r: r["t"]):
        k = (r["agentId"], r.get("lifeIndex"))
        if k in lastt:
            m = AGE.search(r.get("observation", ""))
            st_ = stage(float(m.group(1))) if m else "?"
            cyc[st_].append((r["t"] - lastt[k]) / 1000)
        lastt[k] = r["t"]

    P = np.array([r["promptTokens"] for r in ok]); C = np.array([r["completionTokens"] for r in ok])
    cost = np.array([r["costUsd"] for r in ok]); lat = np.array([r["latencyMs"] for r in ok])
    # visible reply size vs billed completion tokens -> reasoning share (approx 4 chars/token)
    vis_tok = np.array([len(r.get("reply", "")) / 4.0 for r in ok])
    # implied prices (least squares on cost = a*P + b*C)
    A = np.vstack([P, C]).T
    pin, pout = np.linalg.lstsq(A, cost, rcond=None)[0]

    narr = load(D + "narration.jsonl")
    dire = load(D + "director.jsonl")
    dire_llm = [d for d in dire if d.get("costUsd") is not None]
    win_h = (tend - ev[0]["t"]) / 3.6e6
    out[name] = {
        "window_h": win_h, "tend_h": (tend - ev[0]["t"]) / 3.6e6, "slots": len(agents), "slot_h": slot_h,
        "alive_h": alive_h, "alive_frac": alive_h / slot_h,
        "stage_h": dict(stage_h), "stage_frac_of_alive": {k: v / alive_h for k, v in stage_h.items()},
        "lives": len(lives), "eve_lives": sum(1 for l in lives if l[3] > 10),
        "life_len_min": q([(l[2] - l[1]) / 60000 for l in lives if l[4]]),
        "respawn_gap_s": q(gaps) if gaps else None,
        "calls_ok": len(ok), "calls_err": len(err), "err_frac": len(err) / max(1, len(ok) + len(err)),
        "calls_per_slot_h": len(ok) / slot_h,
        "calls_per_alive_h": len(ok) / alive_h,
        "calls_per_stage_h": calls_per_stage_h,
        "calls_by_stage": {s: len(v) for s, v in by_stage.items() if v},
        "calls_per_slot_h_15min_windows": q(rates),
        "cycle_s_by_stage": {s: q(v) for s, v in cyc.items()},
        "prompt_tokens": q(P), "completion_tokens": q(C),
        "prompt_by_stage": {s: q([r["promptTokens"] for r in v]) for s, v in by_stage.items() if v},
        "completion_by_stage": {s: q([r["completionTokens"] for r in v]) for s, v in by_stage.items() if v},
        "visible_reply_tokens_est": q(vis_tok),
        "reasoning_tokens_est_mean": float((C - vis_tok).mean()),
        "cost_per_call": q(cost), "latency_ms": q(lat),
        "implied_price_per_Mtok": {"in": pin * 1e6, "out": pout * 1e6},
        "agent_cost_usd": float(cost.sum()),
        "agent_cost_per_slot_h": float(cost.sum() / slot_h),
        "narrator": {"calls": len(narr), "usd": sum(x.get("costUsd", 0) for x in narr), "usd_per_h": sum(x.get("costUsd", 0) for x in narr) / win_h},
        "director": {"calls": len(dire_llm), "usd": sum(x["costUsd"] for x in dire_llm), "usd_per_h": sum(x["costUsd"] for x in dire_llm) / win_h},
        "models": dict(collections.Counter(r.get("model") for r in ok)),
    }

# director / narrator prompt size vs number of living characters (overhead scales with population)
D = RUNS["dev1"]
rows = []
for d in load(D + "director.jsonl"):
    m = re.search(r"Living characters \((\d+)\)", d.get("prompt", ""))
    if m and d.get("costUsd"):
        rows.append((int(m.group(1)), len(d["prompt"]), d["costUsd"]))
if rows:
    n, ch, c = map(np.array, zip(*rows))
    out["director_scaling"] = {"chars_per_char": float(np.polyfit(n, ch, 1)[0]), "chars_intercept": float(np.polyfit(n, ch, 1)[1]),
                               "usd_per_char": float(np.polyfit(n, c, 1)[0]), "usd_intercept": float(np.polyfit(n, c, 1)[1]), "n_range": [int(n.min()), int(n.max())]}
rows = []
for d in load(D + "narration.jsonl"):
    inp = d.get("input", "")
    k = inp.split("What happened")[0].count("\n- ")
    rows.append((k, len(inp), d.get("costUsd", 0)))
n, ch, c = map(np.array, zip(*rows))
out["narrator_scaling"] = {"usd_per_char": float(np.polyfit(n, c, 1)[0]), "usd_intercept": float(np.polyfit(n, c, 1)[1]), "n_range": [int(n.min()), int(n.max())], "mean_input_chars": float(ch.mean())}
from pathlib import Path
sp = Path(ROOT + "src/agent/prompt.ts").read_text()
out["system_prompt_chars"] = len(sp.split("`")[1])

story = load(STORY)
out["story"] = {"entries": len(story), "keys": sorted(story[0].keys()) if story else [],
                "usd": sum(s.get("costUsd", 0) or 0 for s in story)}
json.dump(out, open("/tmp/ohol-cost/measured.json", "w"), indent=1)
print(json.dumps(out, indent=1))

"""Monte Carlo cost model for the Artificial Selection study.

Inputs: measured.json (from analyze.py), raw/models.json (OpenRouter, fetched 2026-11-17 01:57 UTC).
Outputs: results.json, cost-24h-20slots.png, and printed tables used in report.md.

One Monte Carlo draw = one run. Run-level parameters (mean call rate, mean tokens, cache hit
rate, alive share, ...) are drawn once per run: per-call noise averages out over ~10^5 calls,
so the uncertainty that matters is our uncertainty about the means.
"""
import json, numpy as np

rng = np.random.default_rng(20261117)
N = 40_000
M = json.load(open("/tmp/ohol-cost/measured.json"))
dev, sc = M["dev1"], M["showcase1"]


def ln(median, gsd, n=N):
    """lognormal by median and geometric SD (gsd=1.5 -> ~90% within x/1.95)"""
    return median * np.exp(rng.normal(0, np.log(gsd), n))


def beta_mean(mean, k, n=N):
    return rng.beta(mean * k, (1 - mean) * k, n)


# ---------------------------------------------------------------- measured base (Gemini 3.8 Flash, 2 clean windows)
P_BASE = (dev["prompt_tokens"]["mean"] * dev["calls_ok"] + sc["prompt_tokens"]["mean"] * sc["calls_ok"]) / (dev["calls_ok"] + sc["calls_ok"])  # ~2,877
VIS_BASE = 44.0  # visible reply tokens (JSON), ~chars/4
GEM_REASON = 450.0  # mean (completion - visible), Gemini 3.8 Flash default reasoning
GEM_LAT = 6.45  # mean latency s
SYS_PREFIX = 1100  # static system prompt tokens (4,443 chars); the only shared prefix today
BABY_C_FACTOR = 0.45  # baby completions ~225 vs ~520 tokens

# ---------------------------------------------------------------- run-level shared uncertainty (same draws across models)
U = {
    "act_s": ln(3.2, 1.2),                 # action execution + wait time per cycle (cycle - latency), s
    "baby_share": beta_mean(0.18, 18),     # share of alive slot-time spent age<2 (measured 9-18%; 20 slots spawn more babies)
    "alive": beta_mean(0.95, 60),          # share of slot-time alive (measured 0.97-0.99 short runs; churn adds ~15 s/life)
    "crowd": ln(1.22, 1.15),               # prompt growth with 20 people (+79 tok/person nearby, +25/heard line)
    "lat_noise": ln(1.0, 1.25),            # provider latency vs our point guess
    "reason_noise": ln(1.0, 1.0001),       # placeholder (per-model below)
    "overhead_noise": ln(1.0, 1.3),
}


def overhead_gemini_per_h(living):
    """narrator + director + story, $/h at Gemini 3.8 Flash prices, from dev1 regressions."""
    d = M["director_scaling"]; n = M["narrator_scaling"]
    director = (d["usd_intercept"] + d["usd_per_char"] * living) * 215  # 215 LLM decisions/h measured
    narrator = (n["usd_intercept"] + n["usd_per_char"] * living) * 122  # 122/h measured (30 s interval)
    story = 0.006 * 12
    return director + narrator + story


# ---------------------------------------------------------------- candidates
# price $/Mtok: in, out, cache_read, cache_write ; cache: "auto" (implicit on provider), "explicit" (needs cache_control), "none"
# reason: (median mean reasoning tokens/call at OpenRouter defaults, gsd of our uncertainty) ; vis: visible-length multiplier
# lat: (ttft s, decode tok/s) point guesses for a ~3k prompt, used only to set the call rate
C = [
    # id, label, open, in, out, cr, cw, cache, reason, gsd, vis, ttft, tps
    ("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash", True, 0.09, 0.18, 0.018, 0, "auto", 400, 2.2, 1.1, 1.5, 60),
    ("deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", True, 0.14, 0.42, 0.004, 0, "auto", 400, 2.2, 1.1, 1.5, 70),
    ("qwen/qwen3-32b", "Qwen3 32B", True, 0.08, 0.28, 0.0, 0, "none", 700, 1.8, 1.1, 1.0, 50),
    ("qwen/qwen3.6-35b-a3b", "Qwen3.6 35B-A3B", True, 0.10, 0.90, 0.025, 0, "auto", 900, 1.8, 1.1, 1.0, 120),
    ("openai/gpt-oss-120b", "gpt-oss-120b", True, 0.15, 0.60, 0.075, 0, "auto", 350, 1.8, 1.1, 0.8, 200),
    ("z-ai/glm-5.3", "GLM-5.3", True, 0.07, 1.40, 0.069, 0, "auto", 900, 1.8, 1.2, 2.0, 60),
    ("moonshotai/kimi-k2.6", "Kimi K2.6", True, 0.65, 3.41, 0.15, 0, "auto", 1000, 1.8, 1.2, 2.0, 50),
    ("meta-llama/llama-4-maverick", "Llama 4 Maverick", True, 0.35, 1.00, 0.17, 0, "auto", 0, 1.0, 1.4, 0.6, 120),
    ("google/gemini-3.8-flash", "Gemini 3.8 Flash (current)", False, 0.75, 3.75, 0.075, 0.042, "explicit", GEM_REASON, 1.15, 1.0, None, None),
    ("google/gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", False, 0.25, 1.50, 0.025, 0.083, "explicit", 150, 2.5, 1.0, 1.0, 250),
    ("anthropic/claude-haiku-5.5", "Claude Haiku 5.5", False, 0.10, 0.50, 0.010, 0.125, "explicit", 0, 1.0, 1.6, 0.8, 150),
    ("openai/gpt-5.4-mini", "GPT-5.4 mini", False, 0.75, 4.50, 0.075, 0, "auto", 350, 2.0, 1.1, 1.5, 120),
    ("anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5", False, 2.00, 10.0, 0.10, 2.5, "explicit", 0, 1.0, 1.8, 1.2, 80),
]
KEYS = "id label open pin pout pcr pcw cache reason rgsd vis ttft tps".split()
CANDS = [dict(zip(KEYS, c)) for c in C]

# cross-check against the live list
live = {m["id"]: m for m in json.load(open("/tmp/ohol-cost/raw/models.json"))["data"]}
for c in CANDS:
    assert c["id"] in live, c["id"]
    c["list_in"] = float(live[c["id"]]["pricing"]["prompt"]) * 1e6
    c["list_out"] = float(live[c["id"]]["pricing"]["completion"]) * 1e6


def simulate(c, *, caching=False, slots=20, interval_s=2.5, baby_interval_s=15.0, reasoning_off=False,
             prompt_mult=1.0, static_prefix=SYS_PREFIX, persona_tokens=250, baby_llm=True, call_cut=0.0,
             price_mult=1.0, lat_mult=1.0, hit_mean=0.85):
    """Returns dict of arrays: per-slot-hour agent cost, calls/slot-h, tokens."""
    # --- tokens
    P = P_BASE * U["crowd"] * prompt_mult + persona_tokens  # persona text sits after the shared system prompt
    vis = VIS_BASE * ln(c["vis"], 1.2)
    if reasoning_off or c["reason"] == 0:
        R = np.zeros(N)
    else:
        R = ln(c["reason"], c["rgsd"])
    C_adult = np.minimum(vis + R, 2000)          # LLM_MAX_TOKENS=2000
    C_baby = np.minimum(vis + R * BABY_C_FACTOR, 2000)
    # --- latency -> call rate (cycle = max(interval, latency + action time))
    if c["ttft"] is None:  # measured model: scale measured latency by output length
        lat = (GEM_LAT - 0.0) * (2.2 + C_adult / 150) / (2.2 + (VIS_BASE + GEM_REASON) / 150)
    else:
        lat = c["ttft"] + C_adult / c["tps"]
    lat = lat * U["lat_noise"] * lat_mult
    lat_b = lat * 0.8
    adult_rate = 3600 / np.maximum(interval_s, lat + U["act_s"])
    baby_rate = 3600 / np.maximum(baby_interval_s, lat_b + 0.5)
    b = U["baby_share"]
    calls_adult = U["alive"] * (1 - b) * adult_rate * (1 - call_cut)
    calls_baby = U["alive"] * b * baby_rate * (1 - call_cut) * (1 if baby_llm else 0)
    calls = calls_adult + calls_baby
    # --- price per call
    pin, pout, pcr = c["pin"] * price_mult, c["pout"] * price_mult, c["pcr"] * price_mult
    if caching and c["cache"] != "none" and pcr > 0:
        hit = beta_mean(hit_mean, 20)
        cached = hit * np.minimum(static_prefix, P)
    else:
        cached = np.zeros(N)
    in_cost = ((P - cached) * pin + cached * pcr) / 1e6
    cost_adult = in_cost + C_adult * pout / 1e6
    cost_baby = in_cost + C_baby * pout / 1e6
    per_slot_h = calls_adult * cost_adult + calls_baby * cost_baby
    return {"per_slot_h": per_slot_h, "calls": calls, "P": P, "C": C_adult, "lat": lat,
            "cost_per_call": per_slot_h / np.maximum(calls, 1e-9)}


def overhead(c, cost_per_call, living=20):
    """Narrator/director/story on the same model (code default). Scaled by per-call cost vs Gemini."""
    gem = sims_base["google/gemini-3.8-flash"]["cost_per_call"]
    return overhead_gemini_per_h(living) * (cost_per_call / gem) * U["overhead_noise"]


def q(x):
    return {k: float(v) for k, v in zip(["p2.5", "p10", "p50", "p90", "p97.5", "mean"],
                                        [*np.percentile(x, [2.5, 10, 50, 90, 97.5]), np.mean(x)])}


# ---------------------------------------------------------------- base sims
sims_base = {c["id"]: simulate(c) for c in CANDS}
sims_cache = {c["id"]: (simulate(c, caching=True) if c["cache"] != "none" else sims_base[c["id"]]) for c in CANDS}

results = {}
for c in CANDS:
    s0, s1 = sims_base[c["id"]], sims_cache[c["id"]]
    oh = overhead(c, s0["cost_per_call"])
    run24 = s0["per_slot_h"] * 20 * 24
    run24_c = s1["per_slot_h"] * 20 * 24
    run24_tot = run24 + oh * 24
    run24_c_tot = run24_c + oh * 24 * (np.median(s1["cost_per_call"]) / np.median(s0["cost_per_call"]))
    results[c["id"]] = {
        "label": c["label"], "open": c["open"], "price": [c["pin"], c["pout"], c["pcr"]], "list": [c["list_in"], c["list_out"]],
        "cache": c["cache"],
        "slot_h": q(s0["per_slot_h"]), "slot_h_cached": q(s1["per_slot_h"]),
        "calls_slot_h": q(s0["calls"]), "cost_per_call": q(s0["cost_per_call"]), "lat": q(s0["lat"]), "C": q(s0["C"]),
        "overhead_h": q(oh),
        "run24_agents": q(run24), "run24_agents_cached": q(run24_c),
        "run24_total": q(run24_tot), "run24_total_cached": q(run24_c_tot),
        # $200 buys: slot-hours (agents only) and 4-slot 75-min "current setup" runs incl. overhead at 4 living
        "slot_h_per_200": q(200 / s0["per_slot_h"]),
        "current_runs_per_200": q(200 / (s0["per_slot_h"] * 4 * 1.25 + overhead_gemini_per_h(3.5) * 1.25 * s0["cost_per_call"] / sims_base["google/gemini-3.8-flash"]["cost_per_call"])),
    }

# ---------------------------------------------------------------- sensitivity (Spearman rank corr + p10/p90 swing) for two reference models
def rank(x):
    return np.argsort(np.argsort(x))


sens = {}
for mid in ["google/gemini-3.8-flash", "deepseek/deepseek-v4-flash", "anthropic/claude-haiku-5.5"]:
    c = next(c for c in CANDS if c["id"] == mid)
    # rebuild with the draw arrays exposed
    rng_state = rng.bit_generator.state
    s = simulate(c, caching=True)
    y = s["per_slot_h"]
    drivers = {"action/wait time per cycle": U["act_s"], "prompt growth (crowding)": U["crowd"], "baby share": U["baby_share"],
               "alive share": U["alive"], "provider latency": U["lat_noise"], "completion tokens (reasoning)": s["C"]}
    sens[mid] = {k: float(np.corrcoef(rank(v), rank(y))[0, 1]) for k, v in drivers.items()}

# ---------------------------------------------------------------- levers (Gemini 3.8 Flash and DeepSeek V4 Flash), median 24h x 20 agents only
LEVERS = [
    ("baseline (no caching)", {}),
    ("prompt caching on, system prompt only (1.1k static)", {"caching": True}),
    ("caching + restructure prompt so ~2.0k is static", {"caching": True, "static_prefix": 2000}),
    ("min decision interval 2.5 s -> 6 s", {"interval_s": 6.0}),
    ("min decision interval 2.5 s -> 10 s", {"interval_s": 10.0}),
    ("event-driven: skip ~25% of calls (waits/repeats)", {"call_cut": 0.25}),
    ("no LLM for babies (<2 y scripted)", {"baby_llm": False}),
    ("shorter observations (-30% prompt)", {"prompt_mult": 0.7}),
    ("reasoning off (latency falls -> more calls)", {"reasoning_off": True}),
    ("reasoning off + 6 s interval", {"reasoning_off": True, "interval_s": 6.0}),
    ("flex tier (-50% price, ~1.5x latency)", {"price_mult": 0.5, "lat_mult": 1.5}),
    ("combo: cache(2k) + 6 s + event-driven + no-baby LLM", {"caching": True, "static_prefix": 2000, "interval_s": 6.0, "call_cut": 0.25, "baby_llm": False}),
]
levers = {}
for mid in ["google/gemini-3.8-flash", "deepseek/deepseek-v4-flash", "anthropic/claude-haiku-5.5", "qwen/qwen3-32b"]:
    c = next(c for c in CANDS if c["id"] == mid)
    base = np.median(simulate(c)["per_slot_h"]) * 480
    levers[mid] = []
    for name, kw in LEVERS:
        if mid == "qwen/qwen3-32b" and "flex" in name:
            continue
        v = np.median(simulate(c, **kw)["per_slot_h"]) * 480
        calls = np.median(simulate(c, **kw)["calls"])
        levers[mid].append({"lever": name, "usd_24h_20": float(v), "saving_pct": float(100 * (1 - v / base)), "calls_slot_h": float(calls)})

# ---------------------------------------------------------------- self-hosted steering (B)
# GPU $/h, fetched 2026-11-17: RunPod https://www.runpod.io/pricing ; Lambda https://lambda.com/pricing
GPU = {"L40S": (0.79, 1.09), "A100 80GB": (1.39, 2.19), "H100 PCIe": (1.99, 2.89), "H100 SXM": (2.69, 4.39), "H100 SXM (Lambda)": (4.89, 4.89), "H200": (3.59, 5.29)}


def selfhost(model, slots, thinking, interval_s=2.5, static_prefix=SYS_PREFIX, n_mc=N):
    """Self-hosted vLLM + per-request steering. Capacity from first principles (H100 SXM: 989 TFLOPS BF16 /
    1979 FP8 dense, 3.35 TB/s), cross-checked against published numbers (see report). Returns H100-equivalents."""
    if model == "8B":   # BF16, 16 GB weights
        prefill_cap = ln(30000, 1.35, n_mc); decode_cap = ln(4000, 1.4, n_mc); tps_stream = ln(110, 1.3, n_mc)
    else:               # 32B FP8, 32 GB weights (BF16 would be ~half the prefill rate)
        prefill_cap = ln(15000, 1.35, n_mc); decode_cap = ln(2000, 1.4, n_mc); tps_stream = ln(60, 1.3, n_mc)
    P = P_BASE * U["crowd"][:n_mc] + 250
    uncached = P - 0.9 * static_prefix          # per-agent cache_salt keeps each agent's own static prefix warm
    Cc = VIS_BASE * 1.1 + (ln(600, 1.6, n_mc) if thinking else 0)
    lat = 0.15 + uncached / prefill_cap * 2 + Cc / tps_stream
    b, alive, act = U["baby_share"][:n_mc], U["alive"][:n_mc], U["act_s"][:n_mc]
    rate = alive * ((1 - b) * 3600 / np.maximum(interval_s, lat + act) + b * 3600 / np.maximum(15, lat + 0.5))
    rps = slots * rate / 3600
    steer_eff = beta_mean(0.82, 40, n_mc)       # EasySteer: 71-91% of baseline throughput with vectors applied
    util = (rps * uncached / prefill_cap + rps * Cc / decode_cap) / steer_eff
    n_h100 = np.maximum(1, np.ceil(util / 0.7))  # keep <=70% busy for latency headroom
    return {"util_h100": q(util), "n_h100": q(n_h100), "rps": q(rps), "lat": q(lat), "calls_slot_h": q(rate),
            "n_h100_draws": n_h100}


selfhosted = {}
for model in ["8B", "32B"]:
    for thinking in [False, True]:
        for interval in [2.5, 10.0]:
            for slots in [20, 40]:
                r = selfhost(model, slots, thinking, interval)
                # $/24h: H100 SXM RunPod community 2.69 / secure 4.39, +15% for idle/dev/restarts, + overhead calls on same GPU (free)
                nd = r.pop("n_h100_draws")
                r["usd_24h_community"] = q(nd * 2.69 * 24 * 1.15)
                r["usd_24h_secure"] = q(nd * 4.39 * 24 * 1.15)
                selfhosted[f"{model} thinking={thinking} interval={interval} slots={slots}"] = r

# ---------------------------------------------------------------- standardized cadence (all models at 8 s min interval)
for c in CANDS:
    s8 = simulate(c, interval_s=8.0)
    results[c["id"]]["slot_h_8s"] = q(s8["per_slot_h"])
    results[c["id"]]["calls_slot_h_8s"] = q(s8["calls"])

# ---------------------------------------------------------------- budget: long run length
import os
BUDGET = {"total": float(os.environ.get("BUDGET_TOTAL", 0)), "personnel": float(os.environ.get("BUDGET_PERSONNEL", 0)), "claude_code": float(os.environ.get("BUDGET_TOOLS", 0)), "reserve_other": float(os.environ.get("BUDGET_RESERVE", 0))}  # private; set via env
BUDGET["compute"] = BUDGET["total"] - BUDGET["personnel"] - BUDGET["claude_code"] - BUDGET["reserve_other"]
PILOTS = 400        # includes the $200 now: calibration runs per candidate model
CONTINGENCY = 0.15
plan = {}
for mid in [c["id"] for c in CANDS]:
    r = results[mid]
    day = r["run24_total"]
    avail = BUDGET["compute"] * (1 - CONTINGENCY) - PILOTS
    plan[mid] = {"label": r["label"], "day_p50": day["p50"], "day_p90": day["p90"],
                 "three_runs_p50": 3 * day["p50"],
                 "long_days_p50": (avail - 3 * day["p50"]) / day["p50"],
                 "long_days_p90cost": (avail - 3 * day["p90"]) / day["p90"]}
# self-hosted plan: 32B FP8 no-thinking, 10 s cadence, 20 slots; + 8B
for key in ["32B thinking=False interval=10.0 slots=20", "8B thinking=False interval=10.0 slots=20", "32B thinking=True interval=10.0 slots=20"]:
    day = selfhosted[key]["usd_24h_secure"]
    avail = BUDGET["compute"] * (1 - CONTINGENCY) - PILOTS - 600  # 600 = vector extraction + engine dev GPU time
    plan["selfhost " + key] = {"label": "self-host " + key, "day_p50": day["p50"], "day_p90": day["p90"],
                               "three_runs_p50": 3 * day["p50"], "long_days_p50": (avail - 3 * day["p50"]) / day["p50"],
                               "long_days_p90cost": (avail - 3 * day["p90"]) / day["p90"]}

json.dump({"results": results, "sens": sens, "levers": levers, "selfhosted": selfhosted, "budget": BUDGET, "plan": plan,
           "overhead_gemini_20_living_per_h": overhead_gemini_per_h(20), "overhead_gemini_4_living_per_h": overhead_gemini_per_h(3.5),
           "P_BASE": P_BASE}, open("/tmp/ohol-cost/results.json", "w"), indent=1)

# ---------------------------------------------------------------- print tables
f = lambda x: f"${x:,.0f}" if x >= 10 else f"${x:,.2f}"
print(f"P_BASE={P_BASE:.0f}  overhead gemini @20 living ${overhead_gemini_per_h(20):.2f}/h, @3.5 ${overhead_gemini_per_h(3.5):.2f}/h")
print(f"{'model':30s} {'$/slot-h':>8s} {'calls':>6s} {'$/call':>8s} {'24h agents p50 [95%]':>28s} {'cached p50':>10s} {'total p50 [80%] [95%]':>40s} {'slot-h/$200':>12s} {'runs/$200':>9s}")
for mid, r in sorted(results.items(), key=lambda kv: kv[1]["run24_total"]["p50"]):
    a, t = r["run24_agents"], r["run24_total"]
    print(f"{r['label']:30s} {r['slot_h']['p50']:8.3f} {r['calls_slot_h']['p50']:6.0f} {r['cost_per_call']['p50']*1000:7.3f}m "
          f"{f(a['p50']):>8s} [{f(a['p2.5'])}-{f(a['p97.5'])}]  {f(r['run24_agents_cached']['p50']):>9s} "
          f"{f(t['p50']):>8s} [{f(t['p10'])}-{f(t['p90'])}] [{f(t['p2.5'])}-{f(t['p97.5'])}]  {r['slot_h_per_200']['p50']:10.0f}  {r['current_runs_per_200']['p50']:8.0f}")
print("\nSensitivity (Spearman rho with $/slot-h, caching on):")
for k, v in sens.items():
    print(" ", k, {a: round(b, 2) for a, b in sorted(v.items(), key=lambda kv: -abs(kv[1]))})
print("\nLevers:")
for k, L in levers.items():
    print(" ", k)
    for l in L:
        print(f"    {l['lever']:55s} {f(l['usd_24h_20']):>8s}  {l['saving_pct']:5.0f}%  calls/slot-h {l['calls_slot_h']:.0f}")
print("\nSelf-hosted:")
for k, v in selfhosted.items():
    print(f"  {k:45s} $24h comm={v['usd_24h_community']['p50']:.0f} secure={v['usd_24h_secure']['p50']:.0f} [p90 {v['usd_24h_secure']['p90']:.0f}] util(H100)={v['util_h100']['p50']:.2f} [{v['util_h100']['p10']:.2f}-{v['util_h100']['p90']:.2f}] nH100 p50={v['n_h100']['p50']:.0f} p90={v['n_h100']['p90']:.0f} rps={v['rps']['p50']:.1f} lat={v['lat']['p50']:.1f}s calls/slot-h={v['calls_slot_h']['p50']:.0f}")
print("\n@8s cadence $/slot-h:", {r["label"]: round(r["slot_h_8s"]["p50"], 3) for r in results.values()})
print("\nBudget", BUDGET)
for k, p in plan.items():
    print(f"  {p['label']:55s} day p50 ${p['day_p50']:.0f} p90 ${p['day_p90']:.0f}  3x24h ${p['three_runs_p50']:.0f}  long run {p['long_days_p50']:.1f} d (at p90 cost {p['long_days_p90cost']:.1f} d)")

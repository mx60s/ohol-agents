"""v2: mild reasoning (<=300 tok), TIME_SCALE k, fixed per-model DECISION_CYCLE_MS, 20 slots.
Run: python3 -I model_v2.py  -> results_v2.json, table_v2.txt"""
import json, numpy as np
rng = np.random.default_rng(7); N = 40000
ln = lambda med, g: med * np.exp(rng.normal(0, np.log(g), N))
bm = lambda m, k: rng.beta(m * k, (1 - m) * k, N)
M = json.load(open("/tmp/ohol-cost/measured.json"))
dir_s, nar_s = M["director_scaling"], M["narrator_scaling"]
OH_GEM_DAY = 24 * ((dir_s["usd_intercept"] + dir_s["usd_per_char"] * 20) * 215 + (nar_s["usd_intercept"] + nar_s["usd_per_char"] * 20) * 122 + 0.072)
P_BASE = 2877; VIS = 45
# shared run-level draws
crowd, baby, alive = ln(1.22, 1.15), bm(0.18, 18), bm(0.95, 60)
a_fix, a_game = ln(0.8, 1.3), ln(1.2, 1.3)   # action time: wall part + game-clocked part (walks, animations); 2.0 s at k=1
lat_noise, oh_noise = ln(1, 1.25), ln(1, 1.3)
R = np.minimum(300, ln(220, 1.3))            # mild reasoning, capped ~300

# id: (label, pin, pout, ttft, tps, vis_mult, gpu)   prices $/Mtok live 2026-11-17 (OpenRouter endpoints)
MODELS = {
 "gemini": ("Gemini 3.8 Flash", 0.75, 3.75, None, None, 1.0),
 "haiku": ("Claude Haiku 5.5", 0.10, 0.50, 0.8, 150, 1.6),
 "dsv4": ("DeepSeek V4 Flash", 0.09, 0.18, 1.5, 60, 1.1),
 "gptoss": ("gpt-oss-120b (Groq)", 0.15, 0.60, 0.3, 450, 1.1),
 "qwen32": ("Qwen3-32B API (DeepInfra)", 0.08, 0.28, 1.0, 50, 1.1),
 "self_mild": ("Qwen3-32B self-host, mild reasoning", None, None, 0.35, 70, 1.1),
 "self_nothink": ("Qwen3-32B self-host, no reasoning", None, None, 0.35, 70, 1.1),
}
WIN = {"newborn pip 8.75": 8.75, "cold adult pip+bonus 24.8": 24.8}
GEN_YEARS = 20
out = {}
for key, (label, pin, pout, ttft, tps, vm) in MODELS.items():
    Rm = np.zeros(N) if key == "self_nothink" else R
    C = VIS * vm + Rm
    if ttft is None:   # Gemini: rescale measured 5.4 s median at ~515 completion tokens
        lat = 5.4 * (2.2 + C / 150) / (2.2 + 515 / 150)
    else:
        lat = ttft + C / tps
    lat = lat * lat_noise
    cyc_min = max(4.0, float(np.median(lat)) + 2.0)   # DECISION_CYCLE_MS chosen at k=1 medians
    for k in [1, 1.5, 2, 3]:
        act = a_fix + a_game * k
        cyc = np.maximum(cyc_min, lat + act)
        cyc_b = np.maximum(15, 0.8 * lat + 0.5)
        calls = alive * ((1 - baby) * 3600 / cyc + baby * 3600 / cyc_b)       # per slot-hour
        P = P_BASE * crowd + 250
        gens_day = 24 * 3600 / (GEN_YEARS * 60 * k)
        r = {"label": label, "k": k, "cycle_min_s": cyc_min, "cycle_p50": float(np.median(cyc)), "lat_p50": float(np.median(lat)),
             "calls_slot_h": float(np.median(calls)), "gens_day": gens_day, "lifetimes_day": 24 / k}
        for w, s in WIN.items():
            d = s * k / cyc
            r[w] = (float(np.median(d)), float(np.percentile(d, 10)))
        if pin is not None:
            per_call = (P * pin + C * pout) / 1e6
            day = calls * per_call * 20 * 24
            gem_call = None
            oh = OH_GEM_DAY * np.median(per_call) / 0.00457 * oh_noise   # 0.00457 = Gemini $/call in v1
            tot = day + oh
            r["usd_day"] = [float(x) for x in np.percentile(tot, [10, 50, 90])]
            r["usd_day_agents_p50"] = float(np.median(day))
        else:
            # self-host capacity: 32B FP8 per H100 prefill ~15k tok/s, decode ~2k tok/s, steering 0.82 eff, <=70% busy
            pre, dec, eff = ln(15000, 1.35), ln(2000, 1.4), bm(0.82, 40)
            rps = 20 * calls / 3600
            util = (rps * (P - 0.9 * 1100) / pre + rps * C / dec) / eff
            n = np.maximum(1, np.ceil(util / 0.7))
            r["util_h100"] = [float(x) for x in np.percentile(util, [10, 50, 90])]
            r["p_fits_1_h100"] = float(np.mean(util <= 0.7))
            r["n_h100_p50_p90"] = [float(np.median(n)), float(np.percentile(n, 90))]
            # $/day: GPUs * (RunPod community 2.69 .. secure 4.39) * 24 * 1.15 buffer + narrator/director on cheap API ~$6
            r["usd_day"] = [float(np.percentile(n, 10) * 2.69 * 24 * 1.15 + 6), float(np.median(n) * 2.69 * 24 * 1.15 + 6), float(np.percentile(n, 90) * 4.39 * 24 * 1.15 + 6)]
            r["usd_day_secure_p50"] = float(np.median(n) * 4.39 * 24 * 1.15 + 6)
        r["usd_per_gen"] = [x / gens_day for x in r["usd_day"]]
        out[f"{key} k={k}"] = r
json.dump(out, open("/tmp/ohol-cost/v2/results_v2.json", "w"), indent=1)
print(f"overhead Gemini @20 alive ${OH_GEM_DAY:.0f}/day")
hdr = "| model | k | cycle min / p50 (s) | lat p50 | calls/slot-h | decisions: newborn pip (p50, p10) | cold adult pip+bonus | gens/day (life/day) | $/day 20 slots p50 [80%] | $/generation p50 [80%] | ok? |"
print(hdr); print("|" + "---|" * 11)
for r in out.values():
    nb, ad = r["newborn pip 8.75"], r["cold adult pip+bonus 24.8"]
    ok = "**yes**" if nb[1] >= 2 and ad[1] >= 3 else ("marginal" if nb[0] >= 2 else "no")
    lo, md, hi = r["usd_day"]; g = r["usd_per_gen"]
    extra = f" (1 H100 fits: {r['p_fits_1_h100']*100:.0f}%; util p50 {r['util_h100'][1]:.2f})" if "util_h100" in r else ""
    print(f"| {r['label']} | {r['k']} | {r['cycle_min_s']:.1f} / {r['cycle_p50']:.1f} | {r['lat_p50']:.1f} | {r['calls_slot_h']:.0f} | {nb[0]:.1f} ({nb[1]:.1f}) | {ad[0]:.1f} ({ad[1]:.1f}) | {r['gens_day']:.0f} ({r['lifetimes_day']:.0f}) | ${md:,.0f} [${lo:,.0f}–${hi:,.0f}]{extra} | ${g[1]:,.1f} [${g[0]:,.1f}–${g[2]:,.1f}] | {ok} |")

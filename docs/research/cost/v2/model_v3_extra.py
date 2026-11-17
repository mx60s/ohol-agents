"""v2 setup, two extra models: Kimi K3.1 Pro (default routing vs fast provider) and Claude Opus 5.5 (realistic thinking)."""
import json, numpy as np
rng = np.random.default_rng(11); N = 40000
ln = lambda med, g: med * np.exp(rng.normal(0, np.log(g), N))
bm = lambda m, k: rng.beta(m * k, (1 - m) * k, N)
M = json.load(open("/tmp/ohol-cost/measured.json"))
ds, ns = M["director_scaling"], M["narrator_scaling"]
OH_GEM_DAY = 24 * ((ds["usd_intercept"] + ds["usd_per_char"] * 20) * 215 + (ns["usd_intercept"] + ns["usd_per_char"] * 20) * 122 + 0.072)
GEM_CALL = 0.00457
crowd, baby, alive = ln(1.22, 1.15), bm(0.18, 18), bm(0.95, 60)
a_fix, a_game = ln(0.8, 1.3), ln(1.2, 1.3)
lat_noise, oh_noise = ln(1, 1.25), ln(1, 1.3)
VIS = 45
P = 2877 * crowd + 250
R_mild = np.minimum(300, ln(220, 1.3))
R_opus = np.minimum(1024, ln(450, 1.6))   # Anthropic thinking budget min 1024: realistic use 250-900
R_haiku_real = np.minimum(1024, ln(400, 1.6))

def run(label, pin, pout, ttft, tps, vm, R, ttft_g=1.3, tps_g=1.3):
    C = VIS * vm + R
    lat = (ttft * ln(1, ttft_g) + C / (tps * ln(1, tps_g))) * lat_noise
    cmin = max(4.0, float(np.median(lat)) + 2.0)
    per_call = (P * pin + C * pout) / 1e6
    rows = {}
    for k in [1, 1.5, 2, 3]:
        cyc = np.maximum(cmin, lat + a_fix + a_game * k)
        calls = alive * ((1 - baby) * 3600 / cyc + baby * 3600 / np.maximum(15, 0.8 * lat + 0.5))
        agents = calls * per_call * 480
        nb, ad = 8.75 * k / cyc, 24.8 * k / cyc
        rows[k] = dict(cyc=float(np.median(cyc)), nb=(float(np.median(nb)), float(np.percentile(nb, 10))),
                       ad=(float(np.median(ad)), float(np.percentile(ad, 10))),
                       ok=bool(np.percentile(nb, 10) >= 2 and np.percentile(ad, 10) >= 3), gens=72 / k,
                       agents=agents, per_call=per_call)
    return dict(label=label, cmin=cmin, lat=float(np.median(lat)), lat80=[float(np.percentile(lat, 10)), float(np.percentile(lat, 90))], rows=rows)

haiku = run("Haiku 5.5 (v2, ~220 reasoning)", 0.10, 0.50, 0.8, 150, 1.6, R_mild)
HAIKU_CALL = float(np.median(haiku["rows"][2]["per_call"]))
models = [
    run("Kimi K3.1 Pro, default routing (Relace/Wafer fp4, $0.24/$8.40)", 0.24, 8.402, 2.0, 40, 1.2, R_mild, 1.5, 1.6),
    run("Kimi K3.1 Pro, fast provider (DigitalOcean, $2/$10)", 2.0, 10.0, 1.0, 170, 1.2, R_mild, 1.4, 1.4),
    run("Claude Opus 5.5, thinking (budget 1024, ~450 used)", 4.0, 20.0, 1.5, 60, 1.7, R_opus),
    run("Claude Opus 5.5, thinking off (reference)", 4.0, 20.0, 1.5, 60, 1.7, np.zeros(N)),
    haiku,
    run("Haiku 5.5, realistic thinking (budget 1024, ~400 used)", 0.10, 0.50, 0.8, 150, 1.6, R_haiku_real),
]
def fmt(x): return f"${x:,.0f}" if x >= 10 else f"${x:,.2f}"
print("| model | latency p50 [80%] | min cycle | smallest passing k: decisions nb/adult (p10) | gens/day | $/day same-model overhead p50 [80%] | $/gen | $/day overhead→Haiku p50 [80%] | $/gen | at k=2: decisions nb/adult (p10), $/day same / →Haiku, gens 36, $/gen same / →Haiku |")
print("|" + "---|" * 10)
out = []
for m in models:
    ks = [k for k, r in m["rows"].items() if r["ok"]]
    kk = ks[0] if ks else 3
    def cost(k, to_haiku):
        r = m["rows"][k]
        oh = OH_GEM_DAY * ((HAIKU_CALL if to_haiku else np.median(r["per_call"])) / GEM_CALL) * oh_noise
        t = r["agents"] + oh
        return [float(np.percentile(t, p)) for p in (10, 50, 90)]
    r = m["rows"][kk]; s, h = cost(kk, False), cost(kk, True)
    r2 = m["rows"][2]; s2, h2 = cost(2, False), cost(2, True)
    tag = f"k={kk}" + ("" if ks else " (fails even at 3)")
    print(f"| {m['label']} | {m['lat']:.1f} s [{m['lat80'][0]:.1f}–{m['lat80'][1]:.1f}] | {m['cmin']:.1f} s | **{tag}**: {r['nb'][0]:.1f} ({r['nb'][1]:.1f}) / {r['ad'][0]:.1f} ({r['ad'][1]:.1f}) | {r['gens']:.0f} | {fmt(s[1])} [{fmt(s[0])}–{fmt(s[2])}] | {fmt(s[1]/r['gens'])} | {fmt(h[1])} [{fmt(h[0])}–{fmt(h[2])}] | {fmt(h[1]/r['gens'])} | {r2['nb'][0]:.1f} ({r2['nb'][1]:.1f}) / {r2['ad'][0]:.1f} ({r2['ad'][1]:.1f}){' ok' if r2['ok'] else ' FAIL'}; {fmt(s2[1])} / {fmt(h2[1])}; {fmt(s2[1]/36)} / {fmt(h2[1]/36)} |")
    out.append(dict(label=m["label"], lat=m["lat"], cmin=m["cmin"], k=kk, cost_same=s, cost_haiku=h, k2_same=s2, k2_haiku=h2))
json.dump(out, open("/tmp/ohol-cost/v2/results_v3_extra.json", "w"), indent=1)

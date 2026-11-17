import json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D

R = json.load(open("/tmp/ohol-cost/results.json"))["results"]
rows = sorted(R.values(), key=lambda r: r["run24_total"]["p50"])
SURF, INK, INK2, GRID = "#fcfcfb", "#1f1f1e", "#5f5e58", "#e6e5e0"
OPEN, CLOSED = "#2a78d6", "#eb6834"

fig, ax = plt.subplots(figsize=(10, 6.4), dpi=160)
fig.patch.set_facecolor(SURF); ax.set_facecolor(SURF)
for i, r in enumerate(rows):
    t = r["run24_total"]; col = OPEN if r["open"] else CLOSED
    ax.plot([t["p2.5"], t["p97.5"]], [i, i], color=col, lw=1.6, alpha=0.55, solid_capstyle="round")
    ax.plot([t["p10"], t["p90"]], [i, i], color=col, lw=6, solid_capstyle="round")
    ax.plot([t["p50"]], [i], "o", ms=9, color=col, mec=SURF, mew=2, zorder=3)
    ax.text(t["p97.5"] * 1.08, i, f"${t['p50']:,.0f}", va="center", ha="left", fontsize=9, color=INK)
ax.axvline(200, color=INK2, lw=1, ls=(0, (4, 3)), zorder=0)
ax.text(200 * 1.04, len(rows) - 0.45, "$200 credit", fontsize=8.5, color=INK2, va="center")
ax.set_xscale("log")
ax.set_xlim(20, 6000)
ax.set_yticks(range(len(rows)))
ax.set_yticklabels([r["label"] for r in rows], fontsize=9.5, color=INK)
ax.set_xticks([25, 50, 100, 200, 500, 1000, 2000, 5000])
ax.set_xticklabels(["$25", "$50", "$100", "$200", "$500", "$1k", "$2k", "$5k"], color=INK2, fontsize=9)
ax.grid(axis="x", color=GRID, lw=0.8); ax.set_axisbelow(True)
for s in ["top", "right", "left"]: ax.spines[s].set_visible(False)
ax.spines["bottom"].set_color(GRID)
ax.tick_params(axis="y", length=0); ax.tick_params(axis="x", color=GRID)
ax.set_title("Cost of one 24 h run with 20 agent slots, by model", loc="left", fontsize=13, color=INK, pad=44)
ax.text(0, 1.018, "Monte Carlo, 40k draws. Dot = median, thick bar = 80% interval, thin line = 95%. "
        "Agents + narrator/director/story, no prompt caching,\ncurrent code (2.5 s min interval). "
        "OpenRouter prices fetched 2026-11-17. Log scale.", transform=ax.transAxes, fontsize=8.3, color=INK2, va="bottom")
ax.legend(handles=[Line2D([], [], color=OPEN, lw=6, label="open weights"), Line2D([], [], color=CLOSED, lw=6, label="closed")],
          loc="lower right", frameon=False, fontsize=9)
fig.tight_layout()
fig.savefig("/tmp/ohol-cost/cost-24h-20slots.png", facecolor=SURF)
print("ok")

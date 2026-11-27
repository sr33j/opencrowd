#!/usr/bin/env python3
"""Aggregate the compaction A/B (w125). usage: analyze.py <out dir> [--json]"""
import json, glob, os, sys, statistics as st, math, random
from collections import defaultdict

OUT = sys.argv[1]
# List prices per million tokens (Venice's GPT-6 Luna = OpenRouter's; the seller adds 20%, BlockRun 5%).
LIST = {"openai-gpt-6-luna": (0.10, 0.01, 0.50), "openai-gpt-61-terra": (1.0, 0.05, 5.0), "openai-gpt-62-sol": (2.0, 0.10, 10.0)}

def events(run, wake):
    try: return json.load(open(os.path.join(run, f"wake-{wake}-events.json")))
    except FileNotFoundError: return []

def per_turn(run, record):
    """Ledger rows aligned to turns: [(wake, main_row, summary_row|None, compaction|None)]."""
    rows = list(record["calls"]); i = 0; out = []
    comps = iter(record["compactions"])
    for w in record["wakes"]:
        ev = events(run, w["index"])
        for k, e in enumerate(ev):
            if e["type"] != "calling_llm": continue
            nxt = next((x for x in ev[k + 1:] if x["type"] == "calling_llm"), None)
            comp = next((x for x in ev[k + 1:] if x["message"].startswith("Compacted context") and (nxt is None or x["t"] < nxt["t"])), None)
            c = next(comps) if comp else None
            summary = None
            s = (c or {}).get("summary") or {}
            if c and s and s.get("reason") != "too_large" and s.get("latencyMs") is not None and (s.get("mode") == "llm" or s.get("inputTokens") is not None):
                summary = rows[i] if i < len(rows) else None; i += 1
            main = rows[i] if i < len(rows) else None; i += 1
            out.append((w["index"], main, summary, c))
    return out

def cost_list(model, row):
    p_in, p_cached, p_out = LIST.get(model, (0, 0, 0))
    cached = row.get("cached") or 0; uncached = max(0, (row.get("in") or 0) - cached)
    return (uncached * p_in + cached * p_cached + (row.get("out") or 0) * p_out) / 1e6

def first_visible(run, wake):
    ev = events(run, wake["index"])
    t = next((e["t"] for e in ev if e["type"] in ("calling_tool",)), None)
    return t if t is not None else wake["ms"]

def mean_sd(xs):
    xs = [x for x in xs if x is not None]
    if not xs: return (float("nan"), float("nan"), 0)
    return (st.mean(xs), st.stdev(xs) if len(xs) > 1 else 0.0, len(xs))

def perm_test(a, b, n=20000, seed=7):
    """Two-sided permutation test on the difference of means."""
    a = [x for x in a if x is not None]; b = [x for x in b if x is not None]
    if len(a) < 2 or len(b) < 2: return float("nan")
    obs = abs(st.mean(a) - st.mean(b)); pool = a + b; rnd = random.Random(seed); hits = 0
    for _ in range(n):
        rnd.shuffle(pool)
        if abs(st.mean(pool[:len(a)]) - st.mean(pool[len(a):])) >= obs - 1e-12: hits += 1
    return hits / n

runs = []
for path in sorted(glob.glob(os.path.join(OUT, "*", "record.json"))):
    run = os.path.dirname(path); r = json.load(open(path)); turns = per_turn(run, r)
    model = r["model"]
    mains = [m for _, m, _, _ in turns if m]; sums = [s for _, _, s, _ in turns if s]
    all_rows = r["calls"]
    tin = sum(c.get("in") or 0 for c in all_rows); tcached = sum(c.get("cached") or 0 for c in all_rows); tout = sum(c.get("out") or 0 for c in all_rows)
    # Cache hit rate of the main call right before and right after each compaction.
    before, after = [], []
    for k, (_, m, _, c) in enumerate(turns):
        if c and m and k > 0 and turns[k - 1][1]:
            p = turns[k - 1][1]; before.append((p["cached"] or 0) / max(1, p["in"] or 1)); after.append((m["cached"] or 0) / max(1, m["in"] or 1))
    recall = r["grade"]["recall"]; probe = r["wakes"][-1]
    runs.append({
        "task": r["task"], "arm": r["arm"], "model": model, "rep": r["rep"],
        "success": 1.0 if r["grade"]["success"] else 0.0,
        "recall": sum(bool(v) for v in recall.values()) / len(recall), "recall_items": recall,
        "wall_s": sum(w["ms"] for w in r["wakes"]) / 1000, "first_step_s": first_visible(run, r["wakes"][0]) / 1000,
        "turns": sum(w.get("turns") or 0 for w in r["wakes"]), "probe_turns": probe.get("turns") or 0, "probe_s": probe["ms"] / 1000,
        "calls": len(all_rows), "tokens_in": tin, "tokens_out": tout, "cache_hit": tcached / max(1, tin),
        "paid_usd": sum(c.get("cents") or 0 for c in all_rows) / 100,
        "list_usd": sum(cost_list(model, c) for c in all_rows),
        "compactions": len(r["compactions"]),
        "summary_calls": len(sums), "summary_paid_usd": sum(s.get("cents") or 0 for s in sums) / 100,
        "summary_list_usd": sum(cost_list(model, s) for s in sums),
        "summary_fallbacks": sum(1 for c in r["compactions"] if (c.get("summary") or {}).get("mode") == "fallback"),
        "summary_prefix": sum(1 for c in r["compactions"] if (c.get("summary") or {}).get("prefixOf")),
        "summary_latency_s": sum(((c.get("summary") or {}).get("latencyMs") or 0) for c in r["compactions"]) / 1000,
        "cache_before": st.mean(before) if before else None, "cache_after": st.mean(after) if after else None,
        "errors": sum(1 for w in r["wakes"] if w["outcome"] not in ("completed",)) + sum(1 for c in all_rows if c.get("status") != "charged"),
    })

if "--json" in sys.argv:
    print(json.dumps(runs, indent=1)); sys.exit()

METRICS = [("success", "{:.0%}"), ("recall", "{:.0%}"), ("wall_s", "{:.0f}"), ("first_step_s", "{:.1f}"), ("turns", "{:.1f}"), ("probe_turns", "{:.1f}"),
           ("probe_s", "{:.1f}"), ("tokens_in", "{:,.0f}"), ("tokens_out", "{:,.0f}"), ("cache_hit", "{:.0%}"), ("paid_usd", "${:.4f}"), ("list_usd", "${:.4f}"),
           ("compactions", "{:.1f}"), ("summary_calls", "{:.1f}"), ("summary_list_usd", "${:.5f}"), ("summary_paid_usd", "${:.4f}"), ("summary_fallbacks", "{:.1f}"),
           ("summary_latency_s", "{:.1f}"), ("cache_before", "{:.0%}"), ("cache_after", "{:.0%}"), ("errors", "{:.1f}")]
groups = defaultdict(list)
for x in runs: groups[(x["model"], x["arm"])].append(x)
arms = sorted({a for _, a in groups}, key=lambda a: ["baseline", "llm", "llm_keep3"].index(a) if a in ["baseline", "llm", "llm_keep3"] else 9)
for model in sorted({m for m, _ in groups}):
    present = [a for a in arms if (model, a) in groups]
    print(f"\n## {model}: runs per arm " + ", ".join(f"{a}={len(groups[(model, a)])}" for a in present))
    print("| metric | " + " | ".join(present) + " | " + " | ".join(f"Δ {a}−baseline (p)" for a in present if a != "baseline") + " |")
    print("|---" * (1 + len(present) + len([a for a in present if a != "baseline"])) + "|")
    for name, fmt in METRICS:
        cells = []
        for a in present:
            m, sd, n = mean_sd([x[name] for x in groups[(model, a)]])
            cells.append("n/a" if math.isnan(m) else f"{fmt.format(m)} ± {fmt.format(sd).lstrip('$')}")
        deltas = []
        for a in present:
            if a == "baseline" or ("baseline" not in present): continue
            A = [x[name] for x in groups[(model, a)]]; B = [x[name] for x in groups[(model, "baseline")]]
            ma, _, _ = mean_sd(A); mb, _, _ = mean_sd(B)
            deltas.append("n/a" if math.isnan(ma) or math.isnan(mb) else f"{fmt.format(ma - mb) if not fmt.startswith('$') else ('-' if ma - mb < 0 else '+') + fmt.format(abs(ma - mb))} (p={perm_test(A, B):.2f})")
        print(f"| {name} | " + " | ".join(cells) + " | " + " | ".join(deltas) + " |")
    print("\nPer task (success / recall / probe turns / list $ per run):")
    for task in sorted({x["task"] for x in runs if x["model"] == model}):
        line = [f"  {task:18s}"]
        for a in present:
            xs = [x for x in groups[(model, a)] if x["task"] == task]
            if xs: line.append(f"{a}: {st.mean(x['success'] for x in xs):.0%} / {st.mean(x['recall'] for x in xs):.0%} / {st.mean(x['probe_turns'] for x in xs):.1f} / ${st.mean(x['list_usd'] for x in xs):.4f} (n={len(xs)})")
        print("  ".join(line))
    print("\nRecall items missed (count over runs):")
    for a in present:
        missed = defaultdict(int)
        for x in groups[(model, a)]:
            for k, v in x["recall_items"].items():
                if not v: missed[f"{x['task']}:{k}"] += 1
        print(f"  {a}: " + (", ".join(f"{k}×{v}" for k, v in sorted(missed.items())) or "none"))

#!/usr/bin/env bash
# Multi-seed wrapper around scripts/run-rq.sh.
#
# Runs the five reviewer-flagged RQs (rq1, rq4, rq5-adv, rq8, rq10) across a list
# of base seeds (default 42..51), aggregates the per-seed metrics.parquet
# files into a single multi-seed parquet per RQ, and emits CI tables to
# results/<rq>-ci/. Optionally syncs the CI tables and the headline report
# to a paper repository when RECOURSE_PAPER_DIR is set.
#
# Usage:
#   scripts/run-rq-ci.sh                 # rq1 rq5-adv rq8 rq10, seeds 42..51
#   scripts/run-rq-ci.sh rq1             # single RQ
#   RECOURSE_BASE_SEEDS="42 43 44" scripts/run-rq-ci.sh
#   RECOURSE_PAPER_DIR=/path/to/paper scripts/run-rq-ci.sh
set -euo pipefail

cd "$(dirname "$0")/.."

DEFAULT_RQS=(rq1 rq4 rq5-adv rq8 rq10)
if [ "$#" -gt 0 ]; then
  RQS=("$@")
else
  RQS=("${DEFAULT_RQS[@]}")
fi

BASE_SEEDS_RAW="${RECOURSE_BASE_SEEDS:-42 43 44 45 46 47 48 49 50 51}"
read -r -a BASE_SEEDS <<<"$BASE_SEEDS_RAW"

RESULTS_ROOT="${RECOURSE_RESULTS_ROOT:-results}"
case "$RESULTS_ROOT" in
  /*) ABS_RESULTS="$RESULTS_ROOT" ;;
  *) ABS_RESULTS="$(pwd)/$RESULTS_ROOT" ;;
esac

PAPER_DIR="${RECOURSE_PAPER_DIR:-}"

echo "[run-rq-ci] base seeds: ${BASE_SEEDS[*]}"
echo "[run-rq-ci] RQs: ${RQS[*]}"
echo "[run-rq-ci] output root: $ABS_RESULTS"

for rq in "${RQS[@]}"; do
  case "$rq" in
    rq1|rq4|rq5-adv|rq8|rq10) ;;
    *)
      echo "[run-rq-ci] skipping unsupported RQ: $rq (only rq1, rq4, rq5-adv, rq8, rq10 have CI emitters)" >&2
      continue
      ;;
  esac

  OUT_DIR="$ABS_RESULTS/${rq}-ci"
  mkdir -p "$OUT_DIR"

  cd harness
  uv run python - "$rq" "$OUT_DIR" "../harness/configs/$rq/sweep.yaml" "../harness/configs/budgets.yaml" "${BASE_SEEDS[@]}" <<'PY'
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import yaml

from recourse_harness.multi_seed import run_driver_multi_seed
from recourse_harness.tables import (
    emit_rq1_baselines_ci,
    emit_rq4_ablation_ci,
    emit_rq5_adv_ci,
    emit_rq8_bondsens_ci,
    emit_rq10_correlated_ci,
)

rq = sys.argv[1]
output_dir = Path(sys.argv[2])
config_path = Path(sys.argv[3])
budgets_path = Path(sys.argv[4])
base_seeds = [int(s) for s in sys.argv[5:]]

with config_path.open("r", encoding="utf-8") as fh:
    config = yaml.safe_load(fh)
with budgets_path.open("rb") as fh:
    budget_bytes = fh.read()

config = dict(config)
config["budget_file_hash"] = "sha256:" + hashlib.sha256(budget_bytes).hexdigest()

artifact = run_driver_multi_seed(
    rq, output_dir, config=config, base_seeds=base_seeds,
)
print(f"metrics={artifact.metrics_path}")
print(f"manifest={artifact.manifest_path}")

import pandas as pd
metrics = pd.read_parquet(artifact.metrics_path)
emitters = {
    "rq1": (emit_rq1_baselines_ci, "table_rq1_baselines_ci.tex"),
    "rq4": (emit_rq4_ablation_ci, "table_rq4_ablation_ci.tex"),
    "rq5-adv": (emit_rq5_adv_ci, "table_rq5_adv_ci.tex"),
    "rq8": (emit_rq8_bondsens_ci, "table_rq8_bondsens_ci.tex"),
    "rq10": (emit_rq10_correlated_ci, "table_rq10_correlated_ci.tex"),
}
emitter, filename = emitters[rq]
target = output_dir / filename
emitter(metrics, target)
print(f"table={target}")
PY
  cd - >/dev/null

done

# Generate the multi-seed report markdown summarising headline CIs.
mkdir -p "$ABS_RESULTS/multi-seed"
cd harness
uv run python - "$ABS_RESULTS" "${BASE_SEEDS[@]}" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

from recourse_harness.tables.ci import mean_ci95

results_root = Path(sys.argv[1])
base_seeds = [int(s) for s in sys.argv[2:]]


def load(rq: str) -> pd.DataFrame | None:
    path = results_root / f"{rq}-ci" / "metrics.parquet"
    if not path.exists():
        return None
    return pd.read_parquet(path)


def fmt_int_ci(mean: float, ci: float) -> str:
    return f"{int(round(mean))} ± {int(round(ci))}"


def fmt_float_ci(mean: float, ci: float, *, digits: int = 3) -> str:
    return f"{mean:.{digits}f} ± {ci:.{digits}f}"


lines: list[str] = []
lines.append("# Multi-seed confidence-interval report")
lines.append("")
lines.append(
    f"Base seeds swept: {', '.join(str(s) for s in base_seeds)} "
    f"(N={len(base_seeds)} independent trace seeds = "
    f"{len(base_seeds)} samples per cell)."
)
lines.append("")
lines.append(
    "Confidence intervals are Student-t two-sided 95% (df = n - 1) "
    "computed on independent trace-seed samples. Ordinary single-seed "
    "tables retain their configured repetition behavior."
)
lines.append("")

# ── RQ1 / RQ4 headline: uncompensated-harm reduction ───────────────────
lines.append("## RQ1 / RQ4 — uncompensated-harm reduction")
lines.append("")
df = load("rq1")
if df is None:
    lines.append("_(rq1 metrics not found.)_")
else:
    pg = df[df["workload"] == "postgres"]
    lines.append("**RQ1 sweep (approval=0.6, seed-base):**")
    lines.append("")
    lines.append("| Baseline | Uncomp (mean ± 95% CI) | n |")
    lines.append("|---|---|---|")
    by_baseline = {}
    for baseline, sub in pg.groupby("baseline"):
        mean, ci, n = mean_ci95(sub["uncompensated"].tolist())
        by_baseline[baseline] = (mean, ci, n)
    for baseline in ["none", "human", "oap", "atomix", "auth_plus_local", "centralized", "recourse"]:
        if baseline not in by_baseline:
            continue
        mean, ci, n = by_baseline[baseline]
        lines.append(f"| {baseline} | {fmt_int_ci(mean, ci)} | {n} |")
    lines.append("")

df4 = load("rq4")
if df4 is None:
    lines.append("_(rq4 metrics not found — run `scripts/run-rq-ci.sh rq4` first.)_")
else:
    lines.append("**RQ4 ablation (approval=0.7):**")
    lines.append("")
    lines.append("| Baseline | Uncomp (mean ± 95% CI) | n |")
    lines.append("|---|---|---|")
    by_baseline4 = {}
    for baseline, sub in df4.groupby("baseline"):
        mean, ci, n = mean_ci95(sub["uncompensated"].tolist())
        by_baseline4[baseline] = (mean, ci, n)
        lines.append(f"| {baseline} | {fmt_int_ci(mean, ci)} | {n} |")
    lines.append("")
    if "atomix" in by_baseline4 and "recourse" in by_baseline4:
        atomix_samples = df4[df4["baseline"] == "atomix"]["uncompensated"].tolist()
        recourse_samples = df4[df4["baseline"] == "recourse"]["uncompensated"].tolist()
        if len(atomix_samples) == len(recourse_samples) and atomix_samples:
            paired_diff = [a - r for a, r in zip(atomix_samples, recourse_samples)]
            diff_mean, diff_ci, diff_n = mean_ci95(paired_diff)
            paired_pct = [(a - r) / a if a else 0.0 for a, r in zip(atomix_samples, recourse_samples)]
            pct_mean, pct_ci, _ = mean_ci95(paired_pct)
            lines.append(
                f"**Paired reduction (atomix − recourse) on RQ4**: "
                f"{fmt_int_ci(diff_mean, diff_ci)} units (n={diff_n}); "
                f"relative reduction {pct_mean*100:.1f}% ± {pct_ci*100:.1f} pp."
            )
            sig = "significant" if abs(diff_mean) > diff_ci else "NOT significant"
            lines.append(f"Paired reduction status at α=0.05: **{sig}**.")
    lines.append("")

# ── RQ3 headline: DISHONEST_CLAIMANT FR and BOND_STRESS shortfall ──────
lines.append("## RQ3 — DISHONEST_CLAIMANT FR and BOND_STRESS shortfall")
lines.append("")
df = load("rq5-adv")
if df is None:
    lines.append("_(rq5-adv metrics not found — run `scripts/run-rq-ci.sh rq5-adv` first.)_")
else:
    recourse_only = df[df["baseline"] == "recourse"]
    lines.append("Recourse baseline, per adversary class:")
    lines.append("")
    lines.append("| Adversary | FA | FR | Uncomp | Bond shortfall | n |")
    lines.append("|---|---|---|---|---|---|")
    for adv in ["NONE", "DISHONEST_CLAIMANT", "ABSENT_CHALLENGER", "BOND_STRESS", "COLLUDING_CHALLENGERS"]:
        sub = recourse_only[recourse_only["adversary_class"] == adv]
        if sub.empty:
            continue
        fa_m, fa_ci, n = mean_ci95(sub["false_acceptance"].tolist())
        fr_m, fr_ci, _ = mean_ci95(sub["false_rejection"].tolist())
        un_m, un_ci, _ = mean_ci95(sub["uncompensated"].tolist())
        sh_m, sh_ci, _ = mean_ci95(sub["under_bond_shortfall"].tolist())
        lines.append(
            f"| {adv} | {fmt_float_ci(fa_m, fa_ci)} | {fmt_float_ci(fr_m, fr_ci)} | "
            f"{fmt_int_ci(un_m, un_ci)} | {fmt_int_ci(sh_m, sh_ci)} | {n} |"
        )
    lines.append("")
    # Headline call-outs.
    dc = recourse_only[recourse_only["adversary_class"] == "DISHONEST_CLAIMANT"]
    if not dc.empty:
        fr_m, fr_ci, n = mean_ci95(dc["false_rejection"].tolist())
        sig = "1.00 holds within rounding" if (fr_m - fr_ci) >= 0.99 else "moves below 1.00"
        lines.append(
            f"**DISHONEST_CLAIMANT FR = {fmt_float_ci(fr_m, fr_ci)}** (n={n}). "
            f"The estimate {sig}."
        )
    none = recourse_only[recourse_only["adversary_class"] == "NONE"]
    bs = recourse_only[recourse_only["adversary_class"] == "BOND_STRESS"]
    if not none.empty and not bs.empty and len(none) == len(bs):
        diff = [b - n for b, n in zip(bs["under_bond_shortfall"].tolist(), none["under_bond_shortfall"].tolist())]
        d_m, d_ci, d_n = mean_ci95(diff)
        sig = "significant" if abs(d_m) > d_ci else "NOT significant"
        lines.append(
            f"**BOND_STRESS shortfall lift over NONE**: {fmt_int_ci(d_m, d_ci)} units (n={d_n}); "
            f"the lift is **{sig}** at α=0.05."
        )
    lines.append("")

# ── RQ8 headline: 1× bond knee ─────────────────────────────────────────
lines.append("## RQ8 — Bond knee at 1× cap")
lines.append("")
df = load("rq8")
if df is None:
    lines.append("_(rq8 metrics not found — run `scripts/run-rq-ci.sh rq8` first.)_")
else:
    recourse_only = df[df["baseline"] == "recourse"]
    lines.append("| Mult | Uncomp | Shortfall | Util | n |")
    lines.append("|---|---|---|---|---|")
    by_mult = {}
    for mult, sub in recourse_only.groupby("bond_multiplier"):
        un = mean_ci95(sub["uncompensated"].tolist())
        sh = mean_ci95(sub["under_bond_shortfall"].tolist())
        ut = mean_ci95(sub["bond_utilization"].tolist())
        by_mult[float(mult)] = (un, sh, ut)
        lines.append(
            f"| {float(mult):.2f}× | {fmt_int_ci(un[0], un[1])} | "
            f"{fmt_int_ci(sh[0], sh[1])} | {fmt_float_ci(ut[0], ut[1])} | {un[2]} |"
        )
    lines.append("")
    if 0.5 in by_mult and 1.0 in by_mult:
        half = recourse_only[recourse_only["bond_multiplier"] == 0.5]["uncompensated"].tolist()
        one = recourse_only[recourse_only["bond_multiplier"] == 1.0]["uncompensated"].tolist()
        if len(half) == len(one):
            diff = [h - o for h, o in zip(half, one)]
            d_m, d_ci, n = mean_ci95(diff)
            sig = "significant" if abs(d_m) > d_ci else "NOT significant"
            lines.append(
                f"**Knee at 1× cap**: 0.5× − 1× uncompensated diff = {fmt_int_ci(d_m, d_ci)} "
                f"units (n={n}); knee is **{sig}** at α=0.05."
            )
    lines.append("")

# ── RQ10 headline: correlated-burst shortfall at k=16 ──────────────────
lines.append("## RQ10 — Correlated-burst shortfall at k=16")
lines.append("")
df = load("rq10")
if df is None:
    lines.append("_(rq10 metrics not found — run `scripts/run-rq-ci.sh rq10` first.)_")
else:
    recourse_only = df[df["baseline"] == "recourse"]
    lines.append("| k | Peak lock | Util | Concurrent shortfall | Uncomp | n |")
    lines.append("|---|---|---|---|---|---|")
    for burst, sub in recourse_only.groupby("correlation_burst_size"):
        pl = mean_ci95(sub["bond_peak_concurrent_locked"].tolist())
        ut = mean_ci95(sub["bond_utilization"].tolist())
        sh = mean_ci95(sub["concurrent_shortfall"].tolist())
        un = mean_ci95(sub["uncompensated"].tolist())
        lines.append(
            f"| {int(burst)} | {fmt_int_ci(pl[0], pl[1])} | "
            f"{fmt_float_ci(ut[0], ut[1])} | {fmt_int_ci(sh[0], sh[1])} | "
            f"{fmt_int_ci(un[0], un[1])} | {pl[2]} |"
        )
    lines.append("")
    k16 = recourse_only[recourse_only["correlation_burst_size"] == 16]
    if not k16.empty:
        sh_m, sh_ci, n = mean_ci95(k16["concurrent_shortfall"].tolist())
        sig = "significantly > 0" if (sh_m - sh_ci) > 0 else "NOT significantly > 0"
        lines.append(
            f"**k=16 concurrent shortfall** = {fmt_int_ci(sh_m, sh_ci)} (n={n}); "
            f"{sig} at α=0.05."
        )
    lines.append("")

lines.append("## Summary — headline significance under the multi-seed CI")
lines.append("")
lines.append(
    "| Headline | Multi-seed mean ± 95% CI | Status |"
)
lines.append("|---|---|---|")
# Build a table by reading from the dataframes we already loaded.
df1 = load("rq1")
df4 = load("rq4")
df5 = load("rq5-adv")
df8 = load("rq8")
df10 = load("rq10")

if df4 is not None:
    atomix = df4[df4["baseline"] == "atomix"]["uncompensated"].tolist()
    recourse = df4[df4["baseline"] == "recourse"]["uncompensated"].tolist()
    if len(atomix) == len(recourse) and atomix:
        pct = [(a - r) / a if a else 0.0 for a, r in zip(atomix, recourse)]
        p_m, p_ci, _ = mean_ci95(pct)
        lines.append(
            f"| RQ4 uncompensated-harm reduction (atomix→recourse) | "
            f"{p_m*100:.1f}% ± {p_ci*100:.1f} pp | "
            f"**{'significant' if p_m > p_ci else 'not significant'}** |"
        )

if df5 is not None:
    dc = df5[(df5["baseline"] == "recourse") & (df5["adversary_class"] == "DISHONEST_CLAIMANT")]
    if not dc.empty:
        fr_m, fr_ci, _ = mean_ci95(dc["false_rejection"].tolist())
        held = (fr_m - fr_ci) >= 0.99
        lines.append(
            f"| RQ3 DISHONEST_CLAIMANT FR | "
            f"{fr_m:.3f} ± {fr_ci:.3f} | **{'at 1.00' if held else 'below 1.00'}** |"
        )
    bs = df5[(df5["baseline"] == "recourse") & (df5["adversary_class"] == "BOND_STRESS")]
    none = df5[(df5["baseline"] == "recourse") & (df5["adversary_class"] == "NONE")]
    if not bs.empty and not none.empty and len(bs) == len(none):
        sh_diff = [b - n for b, n in zip(bs["under_bond_shortfall"].tolist(), none["under_bond_shortfall"].tolist())]
        d_m, d_ci, _ = mean_ci95(sh_diff)
        none_m = sum(none["under_bond_shortfall"].tolist()) / len(none)
        lift_pct = (d_m / none_m * 100) if none_m else 0.0
        lift_ci_pct = (d_ci / none_m * 100) if none_m else 0.0
        lines.append(
            f"| RQ3 BOND_STRESS shortfall lift over NONE | "
            f"+{lift_pct:.1f}% ± {lift_ci_pct:.1f} pp | "
            f"**{'significant' if d_m > d_ci else 'not significant'}** |"
        )

if df8 is not None:
    half = df8[(df8["baseline"] == "recourse") & (df8["bond_multiplier"] == 0.5)]["uncompensated"].tolist()
    one = df8[(df8["baseline"] == "recourse") & (df8["bond_multiplier"] == 1.0)]["uncompensated"].tolist()
    if len(half) == len(one) and half:
        diff = [h - o for h, o in zip(half, one)]
        d_m, d_ci, _ = mean_ci95(diff)
        lines.append(
            f"| RQ8 1× bond knee (0.5× − 1× uncomp diff) | "
            f"{int(round(d_m))} ± {int(round(d_ci))} | "
            f"**{'significant' if d_m > d_ci else 'not significant'}** |"
        )

if df10 is not None:
    k16 = df10[(df10["baseline"] == "recourse") & (df10["correlation_burst_size"] == 16)]
    if not k16.empty:
        sh_m, sh_ci, _ = mean_ci95(k16["concurrent_shortfall"].tolist())
        held = (sh_m - sh_ci) > 0
        lines.append(
            f"| RQ10 correlated-burst shortfall at k=16 | "
            f"{int(round(sh_m))} ± {int(round(sh_ci))} | "
            f"**{'significantly > 0' if held else 'not significantly > 0'}** |"
        )

lines.append("")
lines.append("---")
lines.append("")
lines.append(
    "_Generated by `scripts/run-rq-ci.sh`; see "
    "`harness/src/recourse_harness/multi_seed.py` and "
    "`harness/src/recourse_harness/tables/ci.py`._"
)

report = results_root / "multi-seed" / "report.md"
report.parent.mkdir(parents=True, exist_ok=True)
report.write_text("\n".join(lines) + "\n")
print(f"report={report}")
PY

if [ -n "$PAPER_DIR" ]; then
  mkdir -p "$PAPER_DIR/tables"
  for rq in rq1 rq4 rq5-adv rq8 rq10; do
    src="$ABS_RESULTS/${rq}-ci"
    [ -d "$src" ] || continue
    for f in "$src"/table_*_ci.tex; do
      [ -e "$f" ] || continue
      cp "$f" "$PAPER_DIR/tables/$(basename "$f")"
      echo "[run-rq-ci] synced $(basename "$f") -> $PAPER_DIR/tables/"
    done
  done
fi

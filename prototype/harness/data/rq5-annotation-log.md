# RQ5 Second-Annotator Audit Log

The RQ5 routing study requires that its ground-truth route labels be
assigned independently by a second annotator and that disagreements are
resolved before the routing experiment runs.

## Annotators

* **Annotator A — harness author.** Labels live in
  `harness/src/recourse_harness/faults.py` (the per-class expected-route
  table) and `harness/src/recourse_harness/plots/rq5.py`
  (`_EXPECTED_ROUTE_FOR_FAULT`). These reflect the author's reading of
  `main.tex` §III at the time the harness was written.

* **Annotator B — oracle (gpt-5.4-pro browser).** Fed `rq5-annotation-spec.md`
  containing the routing rules from §III and the fault descriptors only;
  given no access to the harness source. Output captured 2026-05-14 from the
  most recent oracle session (`oracle status` lists it as the most recent
  completed run).

Both annotators saw the same routing model and the same fault descriptions.
Neither saw the other's labels before submitting their own.

## Results

`rq5-ground-truth-labels.csv` records the per-fault labels, an agreement
flag, the resolution rule, and notes per row.

| Cell | Count |
| --- | --- |
| Total fault classes | 10 |
| Agree at first pass | 8 |
| Disagree | 2 |

## Disagreements

1. **REC_PARTIAL_FAILURE**: A→arbitrated, B→excluded. Resolved as
   **arbitrated** under the assumption that the example contract's composite
   payout rule covers partial-outcome residuals (§III rule 2). If the
   contract's payout rule does not enumerate partial outcomes, B's
   `excluded` is correct; the harness should make the assumption explicit in
   the κ JSON before the next provider-backed run.

2. **BND_OUT_OF_CAP_LOSS**: A→arbitrated, B→excluded. Resolved as
   **excluded**. The paper rule from §III is unambiguous: boundedness
   failures leave objective recourse and cannot be re-routed into arbitration
   simply because the alleged loss is still measurable. The fix landed in
   the same commit run: `classifier/.../settleability._residual_ok` now
   fails when the uncapped payout exceeds `maxPayout`, `harness/.../faults`
   injects a row-count large enough to overrun the cap rather than zeroing
   the bond, and both expected-route tables (`FAULT_ROUTE_TABLE`,
   `_EXPECTED_ROUTE_FOR_FAULT`) now read "excluded". RQ5 artifacts were
   regenerated against the corrected mapping.

## Reproducibility

The oracle session is re-runnable via `oracle -p "$(cat
rq5-annotation-spec.md)"`. The session id and the bytes of the prompt are
captured in the `oracle status` output so the same input can be re-played by
any future annotator.

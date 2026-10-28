# RQ5 — Ground-Truth Route Labels: Annotation Spec

This document is fed to a second annotator for the RQ5 routing study described
in `main.tex` §IX.G. The harness already encodes one set of expected route
labels per fault class (`_EXPECTED_ROUTE_FOR_FAULT` in
`harness/src/recourse_harness/plots/rq5.py`). Per the paper's experimental
protocol the second annotator labels independently from the contract text and
fault descriptions, *without* running the prototype.

## Routing model (from main.tex §III)

A failed action instance is one of four routes:

* **ineligible** — the action's recourse contract κ failed eligibility before
  execution (e.g. payout rule not total over schema-valid outcomes, scope not
  closed, bond insufficient).
* **optimistic** — the action satisfied every settleability predicate
  (`WithinScope`, `EvidenceOK`, `RecoveryOK`, `ResidualOK`, `NoExcluded`,
  `Computable`, `CollateralOK`). Goes through the optimistic-oracle path with
  a challenge window.
* **arbitrated** — one or more of `EvidenceOK`, `RecoveryOK`, `Computable`, or
  `CollateralOK` failed, but the alleged loss is still inside the covered
  class `L` and below the cap. Disputable, but covered.
* **excluded** — `WithinScope`, `ResidualOK`, or `NoExcluded` failed; or the
  harm class is outside `L` (data exfiltration, irreversible transfers,
  uncapped downstream effects). Objective recourse does not apply; arbitration
  can only resolve contract-defined defaults.

## Fault classes (from harness/src/recourse_harness/faults.py)

For each fault class below, return the most appropriate route under the rules
above. Assume the underlying recourse contract was already eligible at
admission time; the fault is what breaks settlement.

| ID                       | Description (what the fault perturbs) |
| ------------------------ | -------------------------------------- |
| `NONE`                   | Clean execution. No fault injected. |
| `OBS_HIDE_PRESTATE`      | Effect receipt's pre-state digest is hidden / unrecoverable. |
| `OBS_REMOVE_PROVIDER_SIG`| Provider receipt signature is removed; only adapter-attested. |
| `OBS_AMBIGUOUS_RESOURCE` | Resource identifier in effect receipt is ambiguous (matches multiple resources). |
| `REC_STALE_SNAPSHOT`     | Compensator's snapshot is older than the contract's freshness pre-condition. |
| `REC_INVALID_ARTIFACT`   | Recovery artifact's hash does not match the registered evidence-schema. |
| `REC_PARTIAL_FAILURE`    | Compensator returns `partial`; residual is measurable but non-zero. |
| `BND_OUT_OF_CAP_LOSS`    | Alleged residual loss exceeds the contract's maxPayout cap. |
| `BND_DOWNSTREAM_LEAK`    | Failure caused excluded harm: public disclosure or uncapped downstream. |
| `CMP_SUBJECTIVE_RULE`    | Payout rule requires free-form judgment (no objective P(o,r)). |

## Output format

Reply with a markdown table of two columns, no commentary:

```
| fault_class | route |
| --- | --- |
| NONE | ... |
| OBS_HIDE_PRESTATE | ... |
| ... |
```

Use exactly one of `ineligible`, `optimistic`, `arbitrated`, `excluded` per
row.

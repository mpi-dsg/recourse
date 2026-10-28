"""LaTeX table-fragment emitters for paper figures."""

from .ci import (
    emit_rq1_baselines_ci,
    emit_rq4_ablation_ci,
    emit_rq5_adv_ci,
    emit_rq8_bondsens_ci,
    emit_rq10_correlated_ci,
)
from .rq1 import emit_rq1_baselines
from .rq2 import emit_rq2_predicates
from .rq2_reasons import emit_rq2_reasons
from .rq3 import emit_rq3_capital
from .rq4 import emit_rq4_ablation
from .rq5 import emit_rq5_routing
from .rq5_adv import emit_rq5_adv
from .rq8 import emit_rq8_bondsens
from .rq9 import emit_rq9_frontier
from .rq10 import emit_rq10_correlated

__all__ = [
    "emit_rq1_baselines",
    "emit_rq1_baselines_ci",
    "emit_rq2_predicates",
    "emit_rq4_ablation_ci",
    "emit_rq2_reasons",
    "emit_rq3_capital",
    "emit_rq4_ablation",
    "emit_rq5_routing",
    "emit_rq5_adv",
    "emit_rq5_adv_ci",
    "emit_rq8_bondsens",
    "emit_rq8_bondsens_ci",
    "emit_rq9_frontier",
    "emit_rq10_correlated",
    "emit_rq10_correlated_ci",
]

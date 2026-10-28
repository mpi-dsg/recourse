"""LaTeX formatting helpers shared across table emitters."""

from __future__ import annotations

from pathlib import Path

_TEX_ESCAPES = {
    "\\": r"\textbackslash{}",
    "&": r"\&",
    "%": r"\%",
    "$": r"\$",
    "#": r"\#",
    "_": r"\_",
    "{": r"\{",
    "}": r"\}",
    "~": r"\textasciitilde{}",
    "^": r"\textasciicircum{}",
}


def tex_escape(value: str) -> str:
    return "".join(_TEX_ESCAPES.get(ch, ch) for ch in value)


def fmt_int(value: float) -> str:
    return f"{int(round(value))}"


def fmt_float(value: float, *, digits: int = 2) -> str:
    return f"{value:.{digits}f}"


def write_rows(
    output_path: Path,
    header: str,
    rows: list[str],
    macro_name: str,
) -> Path:
    """Emit a `\\def\\<macro_name>{...}` definition.

    Using a macro instead of raw rows lets the consuming `.tex` source call
    `\\<macro_name>` *inside* a tabular cell context. `\\input{}` of raw
    `\\\\`-terminated rows triggers booktabs "Misplaced \\noalign" because the
    file-read injects an end-of-file token that confuses `\\halign`.
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    body = "\n  ".join(rows)
    output_path.write_text(
        f"{header.strip()}\n"
        f"\\def\\{macro_name}{{%\n"
        f"  {body}%\n"
        f"}}\n"
    )
    return output_path

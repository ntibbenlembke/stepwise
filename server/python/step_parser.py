#!/usr/bin/env python3
"""
step_parser.py — Stepwise Python step-definition extractor
===========================================================

Reads a JSON array of Python file paths from stdin, walks the AST of each
file looking for functions decorated with @given / @when / @then (pytest-bdd),
and writes a JSON array of step definition objects to stdout.

Each output object has the shape:
    {
        "pattern":   str,   # the step pattern string
        "file":      str,   # absolute path to the source file
        "line":      int,   # 1-based line number of the decorated function
        "decorator": str    # "given" | "when" | "then"
    }

Supported decorator call forms
-------------------------------
Plain string (most common):
    @given("I have {count:d} cucumbers")

parsers.cfparse / parsers.parse (angle-bracket or format strings):
    @given(parsers.cfparse("I have {count:d} cucumbers"))
    @given(parsers.parse("I have {count} cucumbers"))

re.compile / raw regex string:
    @given(re.compile(r"I have (\\d+) cucumbers"))

Keyword argument form:
    @given(target_fixture="...", pattern="I have {count:d} cucumbers")

Fully-qualified decorator names are also handled:
    @pytest_bdd.given(...)

Usage (called by the TypeScript language server):
    echo '["path/to/steps.py"]' | python3 step_parser.py
"""

import ast
import json
import sys
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

STEP_DECORATOR_NAMES = {"given", "when", "then"}

# ---------------------------------------------------------------------------
# Pattern extraction helpers
# ---------------------------------------------------------------------------


def _constant_string(node: ast.expr) -> Optional[str]:
    """Return the string value if *node* is a string constant, else None."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def _extract_from_wrapper_call(call: ast.Call) -> Optional[Dict[str, Any]]:
    """
    Handle helper-function wrappers:
        parsers.cfparse("pattern")
        parsers.parse("pattern")
        re.compile(r"pattern")

    Returns {"pattern": str, "is_regex": bool} or None if the call doesn't
    match a recognised wrapper form.
    """
    func = call.func
    attr_name: Optional[str] = None
    module_name: Optional[str] = None

    if isinstance(func, ast.Attribute):
        attr_name = func.attr
        if isinstance(func.value, ast.Name):
            module_name = func.value.id
    elif isinstance(func, ast.Name):
        attr_name = func.id

    if attr_name not in {"cfparse", "parse", "compile"}:
        return None

    if not call.args:
        return None

    val = _constant_string(call.args[0])
    if val is None:
        return None

    # re.compile() produces a raw regex; parsers.cfparse/parse produce format strings.
    is_regex = attr_name == "compile" and module_name == "re"
    return {"pattern": val, "is_regex": is_regex}


def extract_pattern(decorator: ast.expr) -> Optional[Dict[str, Any]]:
    """
    Given the AST node of a decorator, return a dict with the step pattern
    and its source type, or None if it cannot be determined statically.

    Return shape:  {"pattern": str, "is_regex": bool}

    Handles:
        @given("pattern")                   — Call with a string literal arg
        @given(parsers.cfparse("pattern"))  — Call wrapping a helper call
        @given(parsers.parse("pattern"))
        @given(re.compile(r"pattern"))
        @given(target_fixture=..., name="pattern")  — Keyword arg forms
    """
    if not isinstance(decorator, ast.Call):
        return None

    # --- Positional argument ---
    if decorator.args:
        first = decorator.args[0]
        # Direct string literal
        val = _constant_string(first)
        if val is not None:
            return {"pattern": val, "is_regex": False}
        # Wrapped call: parsers.cfparse(...) / re.compile(...) etc.
        if isinstance(first, ast.Call):
            info = _extract_from_wrapper_call(first)
            if info is not None:
                return info

    # --- Keyword arguments ---
    # pytest-bdd accepts: @given(target_fixture="...", name="pattern")
    for kw in decorator.keywords:
        if kw.arg in ("name", "pattern"):
            val = _constant_string(kw.value)
            if val is not None:
                return {"pattern": val, "is_regex": False}
            if isinstance(kw.value, ast.Call):
                info = _extract_from_wrapper_call(kw.value)
                if info is not None:
                    return info

    return None


# ---------------------------------------------------------------------------
# Decorator name resolution
# ---------------------------------------------------------------------------


def get_decorator_name(decorator: ast.expr) -> Optional[str]:
    """
    Return the normalised decorator name ("given" / "when" / "then") if this
    is a recognised step decorator, else None.

    Handles:
        @given(...)         — ast.Call with ast.Name func
        @pytest_bdd.given(...)  — ast.Call with ast.Attribute func
        @given              — bare ast.Name (no arguments, unusual but possible)
        @pytest_bdd.given   — bare ast.Attribute
    """
    node: Optional[ast.expr] = None

    if isinstance(decorator, ast.Call):
        node = decorator.func
    else:
        node = decorator

    if isinstance(node, ast.Name):
        return node.id.lower() if node.id.lower() in STEP_DECORATOR_NAMES else None

    if isinstance(node, ast.Attribute):
        name = node.attr.lower()
        return name if name in STEP_DECORATOR_NAMES else None

    return None


# ---------------------------------------------------------------------------
# File parser
# ---------------------------------------------------------------------------


def parse_file(filepath: str) -> List[Dict[str, Any]]:
    """
    Parse a single Python file and return a list of step definition dicts.
    Silently skips files that cannot be read or parsed.
    """
    try:
        with open(filepath, "r", encoding="utf-8", errors="replace") as fh:
            source = fh.read()
    except OSError:
        return []

    try:
        tree = ast.parse(source, filename=filepath)
    except SyntaxError:
        return []

    results: List[Dict[str, Any]] = []

    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue

        for dec in node.decorator_list:
            dec_name = get_decorator_name(dec)
            if dec_name is None:
                continue

            info = extract_pattern(dec)
            if info is None:
                # Decorator is a step keyword but we couldn't extract a static
                # pattern (e.g. it's a variable reference).  Skip.
                continue

            results.append(
                {
                    "pattern": info["pattern"],
                    "is_regex": info["is_regex"],
                    "file": filepath,
                    "line": node.lineno,
                    "decorator": dec_name,
                }
            )

    return results


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    raw_input = sys.stdin.read().strip()
    if not raw_input:
        json.dump([], sys.stdout)
        return

    try:
        filepaths: List[str] = json.loads(raw_input)
    except json.JSONDecodeError as exc:
        print(f"[step_parser] Invalid JSON input: {exc}", file=sys.stderr)
        json.dump([], sys.stdout)
        return

    if not isinstance(filepaths, list):
        print("[step_parser] Expected a JSON array of file paths.", file=sys.stderr)
        json.dump([], sys.stdout)
        return

    all_steps: List[Dict[str, Any]] = []
    for fp in filepaths:
        if not isinstance(fp, str):
            continue
        all_steps.extend(parse_file(fp))

    json.dump(all_steps, sys.stdout, indent=2, ensure_ascii=False)
    # Ensure final newline (some shells prefer this)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()

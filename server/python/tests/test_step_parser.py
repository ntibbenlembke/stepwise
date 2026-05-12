"""
Tests for step_parser.py

Runs against the real AST extractor using temporary Python files so we test
the full parse path without needing a running pytest-bdd installation.
"""

import io
import json
import os
import sys
import tempfile
import textwrap
from typing import List, Dict, Any

import pytest

# Allow importing step_parser from the parent directory
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from step_parser import parse_file, main  # noqa: E402


# ── Helpers ───────────────────────────────────────────────────────────────────


def write_py(content: str) -> str:
    """Write dedented content to a temp .py file; return its path."""
    f = tempfile.NamedTemporaryFile(
        suffix=".py", mode="w", encoding="utf-8", delete=False
    )
    f.write(textwrap.dedent(content))
    f.close()
    return f.name


def patterns(results: List[Dict[str, Any]]) -> List[str]:
    return [r["pattern"] for r in results]


def decorators(results: List[Dict[str, Any]]) -> List[str]:
    return [r["decorator"] for r in results]


# ── Basic extraction ──────────────────────────────────────────────────────────


def test_given_plain_string():
    path = write_py("""
        from pytest_bdd import given

        @given("I am logged in")
        def step():
            pass
    """)
    results = parse_file(path)
    assert patterns(results) == ["I am logged in"]
    assert decorators(results) == ["given"]


def test_when_and_then():
    path = write_py("""
        from pytest_bdd import when, then

        @when("I click the button")
        def click():
            pass

        @then("the form is submitted")
        def check():
            pass
    """)
    results = parse_file(path)
    assert len(results) == 2
    assert set(decorators(results)) == {"when", "then"}


def test_line_numbers_are_1_based_and_ordered():
    path = write_py("""
        from pytest_bdd import given, when

        @given("step one")
        def step_one():
            pass

        @when("step two")
        def step_two():
            pass
    """)
    results = parse_file(path)
    assert len(results) == 2
    assert results[0]["line"] >= 1
    assert results[0]["line"] < results[1]["line"]


def test_file_path_is_absolute():
    path = write_py("""
        from pytest_bdd import given

        @given("any step")
        def step():
            pass
    """)
    results = parse_file(path)
    assert results[0]["file"] == path


# ── parsers wrappers ──────────────────────────────────────────────────────────


def test_parsers_parse():
    path = write_py("""
        from pytest_bdd import given
        from pytest_bdd import parsers

        @given(parsers.parse("I have {count:d} items"))
        def step():
            pass
    """)
    results = parse_file(path)
    assert patterns(results) == ["I have {count:d} items"]


def test_parsers_cfparse():
    path = write_py("""
        from pytest_bdd import given
        from pytest_bdd import parsers

        @given(parsers.cfparse("count is {n:d}"))
        def step():
            pass
    """)
    results = parse_file(path)
    assert patterns(results) == ["count is {n:d}"]


# ── Fully-qualified decorator names ──────────────────────────────────────────


def test_pytest_bdd_attribute_form():
    path = write_py("""
        import pytest_bdd

        @pytest_bdd.given("I use the attribute form")
        def step():
            pass
    """)
    results = parse_file(path)
    assert patterns(results) == ["I use the attribute form"]
    assert decorators(results) == ["given"]


# ── Keyword argument forms ────────────────────────────────────────────────────


def test_target_fixture_with_positional_pattern():
    """target_fixture kwarg should not prevent extracting a positional pattern."""
    path = write_py("""
        from pytest_bdd import given

        @given("I set up a fixture", target_fixture="my_val")
        def step():
            return 42
    """)
    results = parse_file(path)
    assert patterns(results) == ["I set up a fixture"]


def test_name_keyword_argument():
    path = write_py("""
        from pytest_bdd import given

        @given(name="using keyword name arg")
        def step():
            pass
    """)
    results = parse_file(path)
    assert patterns(results) == ["using keyword name arg"]


def test_pattern_keyword_argument():
    path = write_py("""
        from pytest_bdd import given

        @given(pattern="using keyword pattern arg")
        def step():
            pass
    """)
    results = parse_file(path)
    assert patterns(results) == ["using keyword pattern arg"]


# ── Async functions ───────────────────────────────────────────────────────────


def test_async_def():
    path = write_py("""
        from pytest_bdd import when

        @when("I call an async step")
        async def step():
            pass
    """)
    results = parse_file(path)
    assert patterns(results) == ["I call an async step"]


# ── Multiple steps in one file ────────────────────────────────────────────────


def test_multiple_steps_extracted():
    path = write_py("""
        from pytest_bdd import given, when, then

        @given("the system is ready")
        def setup():
            pass

        @when("I perform an action")
        def action():
            pass

        @then("the result is correct")
        def check():
            pass
    """)
    results = parse_file(path)
    assert len(results) == 3
    assert set(decorators(results)) == {"given", "when", "then"}


# ── Non-BDD decorators are ignored ────────────────────────────────────────────


def test_non_bdd_decorators_ignored():
    path = write_py("""
        import pytest
        from pytest_bdd import given

        @pytest.fixture
        def my_fixture():
            return 42

        @given("I use a fixture")
        def step(my_fixture):
            pass
    """)
    results = parse_file(path)
    assert len(results) == 1
    assert patterns(results) == ["I use a fixture"]


def test_non_step_call_decorator_ignored():
    path = write_py("""
        from pytest_bdd import given

        def my_decorator(f):
            return f

        @my_decorator
        def unrelated():
            pass

        @given("only this one")
        def step():
            pass
    """)
    results = parse_file(path)
    assert patterns(results) == ["only this one"]


# ── Error tolerance ───────────────────────────────────────────────────────────


def test_syntax_error_file_returns_empty():
    path = write_py("this is !!! not valid python !!!")
    assert parse_file(path) == []


def test_nonexistent_file_returns_empty():
    assert parse_file("/nonexistent/path/that/does/not/exist.py") == []


def test_empty_file_returns_empty():
    path = write_py("")
    assert parse_file(path) == []


def test_file_with_no_steps_returns_empty():
    path = write_py("""
        def plain_function():
            pass

        class MyClass:
            def method(self):
                pass
    """)
    assert parse_file(path) == []


# ── main() stdin/stdout protocol ─────────────────────────────────────────────


def test_main_reads_file_list_and_outputs_json(capsys):
    path = write_py("""
        from pytest_bdd import given

        @given("main protocol works")
        def step():
            pass
    """)
    sys.stdin = io.StringIO(json.dumps([path]))
    main()
    sys.stdin = sys.__stdin__

    captured = capsys.readouterr()
    output = json.loads(captured.out)
    assert isinstance(output, list)
    assert any(s["pattern"] == "main protocol works" for s in output)


def test_main_with_empty_input_returns_empty_array(capsys):
    sys.stdin = io.StringIO("")
    main()
    sys.stdin = sys.__stdin__

    captured = capsys.readouterr()
    assert json.loads(captured.out) == []


def test_main_with_invalid_json_returns_empty_array(capsys):
    sys.stdin = io.StringIO("not json at all")
    main()
    sys.stdin = sys.__stdin__

    captured = capsys.readouterr()
    assert json.loads(captured.out) == []


# ── is_regex field ────────────────────────────────────────────────────────────


def test_plain_string_is_not_regex():
    path = write_py("""
        from pytest_bdd import given

        @given("I eat {count:d} cucumbers")
        def step():
            pass
    """)
    steps = parse_file(path)
    assert len(steps) == 1
    assert steps[0]["is_regex"] is False


def test_parsers_cfparse_is_not_regex():
    path = write_py("""
        from pytest_bdd import given
        from pytest_bdd import parsers

        @given(parsers.cfparse("I have {count:d} items"))
        def step():
            pass
    """)
    steps = parse_file(path)
    assert len(steps) == 1
    assert steps[0]["is_regex"] is False


def test_parsers_parse_is_not_regex():
    path = write_py("""
        from pytest_bdd import given
        from pytest_bdd import parsers

        @given(parsers.parse("I have {count} items"))
        def step():
            pass
    """)
    steps = parse_file(path)
    assert len(steps) == 1
    assert steps[0]["is_regex"] is False


def test_re_compile_is_regex():
    path = write_py(r"""
        import re
        from pytest_bdd import given

        @given(re.compile(r"I eat (\d+) cucumbers?"))
        def step():
            pass
    """)
    steps = parse_file(path)
    assert len(steps) == 1
    assert steps[0]["pattern"] == r"I eat (\d+) cucumbers?"
    assert steps[0]["is_regex"] is True


def test_re_compile_pattern_preserved_verbatim():
    """The raw regex string must be stored exactly as written, including anchors."""
    path = write_py(r"""
        import re
        from pytest_bdd import given

        @given(re.compile(r"^the user (\w+) is logged (in|out)$"))
        def step():
            pass
    """)
    steps = parse_file(path)
    assert len(steps) == 1
    assert steps[0]["pattern"] == r"^the user (\w+) is logged (in|out)$"
    assert steps[0]["is_regex"] is True


def test_other_compile_call_is_not_regex():
    """compile() not prefixed with the re module should not be flagged as regex."""
    path = write_py("""
        from pytest_bdd import given

        def compile(x):
            return x

        @given(compile("I do something"))
        def step():
            pass
    """)
    steps = parse_file(path)
    assert len(steps) == 1
    assert steps[0]["is_regex"] is False

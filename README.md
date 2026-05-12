# StepWise — BDD/Gherkin Language Support for VS Code

[![CI](https://img.shields.io/github/actions/workflow/status/TalonTest/StepWise/ci.yml?style=flat-square&label=CI)](https://github.com/TalonTest/StepWise/actions/workflows/ci.yml)

A VS Code extension that brings PyCharm-style BDD support to `.feature` files backed by [pytest-bdd](https://pytest-bdd.readthedocs.io/) step definitions.

## Features

| Feature | Details |
|---|---|
| **Syntax highlighting** | Keywords, tags, comments, parameters, docstrings, data tables |
| **Diagnostics** | Warning squiggle on every step that has no matching definition |
| **Go-to-definition** | `F12` / Ctrl+Click on a step line jumps to the Python function |
| **Completion** | Step suggestions as you type after `Given` / `When` / `Then` |
| **Formatting** | Auto-format `.feature` files with `Shift+Alt+F` |
| **Scenario Outline support** | `<placeholder>` steps are matched correctly without false warnings |

## Requirements

- **Python 3.8+** on your `PATH` (`python3` or `python`)
- **pytest-bdd** installed in your project's environment (the parser only needs the source files; the library itself doesn't have to be importable)
- **Node.js 18+** and **npm** (to build the extension)

## Setup

```bash
# 1. Install Node dependencies
npm install

# 2. Compile TypeScript → JavaScript
npm run build
```

## Running in VS Code

1. Open the `stepwise` folder in VS Code.
2. Press **F5** (or **Run → Start Debugging**) — this launches an *Extension Development Host* window with the extension loaded.
3. Open any `.feature` file in the development host.  
   The language server will scan your workspace for `*.py` files and index all `@given` / `@when` / `@then` definitions automatically.

## Configuration

| Setting | Type | Default | Description |
|---|---|---|---|
| `stepwise.stepDefinitionPaths` | `string[]` | `[]` | Directories to search for step definitions, relative to each workspace root or absolute. Leave empty to search the entire workspace. |
| `stepwise.pythonPath` | `string` | `""` | Path to the Python 3 interpreter. Leave empty to auto-detect `python3` / `python` on `PATH`. |

**Example** (`settings.json`):
```json
{
  "stepwise.stepDefinitionPaths": ["tests/steps", "features/step_defs"],
  "stepwise.pythonPath": "/usr/local/bin/python3"
}
```

The step definition index is refreshed automatically whenever a `.py` file changes or the settings are updated.

## Formatting

Pressing **Shift+Alt+F** on a `.feature` file applies the following rules:

- `Feature:` / `Rule:` — no indent
- `Background:` / `Scenario:` / `Scenario Outline:` — 1× indent
- Steps (`Given` / `When` / `Then` / `And` / `But`) / `Examples:` — 2× indent
- Data table rows / doc-string delimiters — 3× indent
- Data table columns are padded so all `|` pipes align
- Tags and comments inherit the indent of the line that follows them
- Multiple consecutive blank lines are collapsed to one
- Doc-string content is preserved verbatim

Indentation width follows VS Code's **Editor: Tab Size** and **Editor: Insert Spaces** settings for the file.

## Scenario Outlines

Steps inside a `Scenario Outline` that contain `<placeholder>` tokens are matched against step definitions correctly — `<count>` is treated as a wildcard that can match `{count:d}`, `{count}`, or any other parameter form, so no false warning squiggles are shown.

```gherkin
Scenario Outline: add items
  Given I have <count> items in my cart   # ✓ matched, no warning
  When I add <quantity> more

  Examples:
    | count | quantity |
    | 5     | 3        |
```

## Project Structure

```
stepwise/
├── package.json                 Extension manifest & npm scripts
├── tsconfig.json                TypeScript project references (root)
├── tsconfig.test.json           TypeScript config for the test suite
├── jest.config.js               Jest configuration
├── language-configuration.json  Comment/bracket config for Gherkin
├── syntaxes/
│   └── gherkin.tmLanguage.json  TextMate grammar for .feature files
├── client/
│   ├── tsconfig.json
│   └── src/
│       └── extension.ts         VS Code extension entry point
├── server/
│   ├── tsconfig.json
│   ├── src/
│   │   ├── server.ts            LSP server (diagnostics, definition, completion, formatting)
│   │   ├── stepMatcher.ts       Pattern → regex conversion, matching, outline support
│   │   └── formatter.ts         Gherkin auto-formatter
│   └── python/
│       └── step_parser.py       Python AST-based step-definition extractor
└── tests/
    ├── stepMatcher.test.ts      Unit tests for matching & parsing
    ├── formatter.test.ts        Unit tests for the formatter
    └── server/python/tests/
        └── test_step_parser.py  Unit tests for the Python extractor
```

## Supported Step Definition Patterns

The parser handles every common pytest-bdd decorator form:

```python
from pytest_bdd import given, when, then, parsers

# Plain string
@given("I have {count:d} cucumbers in my basket")

# parsers.cfparse (cfparse format codes)
@when(parsers.cfparse("I eat {count:d} cucumbers"))

# parsers.parse (parse library format codes)
@then(parsers.parse("I should have {count:d} cucumbers"))

# Keyword argument form (newer pytest-bdd)
@given(target_fixture="cucumbers", name="I have {count:d} cucumbers")

# re.compile (raw regex — pattern shown as-is in completion)
@when(re.compile(r"I eat (\d+) cucumbers?"))

# Fully-qualified
@pytest_bdd.then("the basket should be empty")
```

## Parameter Format Codes (pattern → regex)

| Code | Matches | Regex |
|---|---|---|
| `{x}` or `{x:S}` | any string | `(.+)` |
| `{x:d}` | integer | `(\d+)` |
| `{x:f}` | float | `([-+]?\d*\.\d+)` |
| `{x:w}` | word (alphanumeric + `_`) | `(\w+)` |
| `{x:s}` | non-whitespace token | `(\S+)` |
| `{x:l}` | lower-case letters | `([a-z]+)` |
| `{x:u}` | upper-case letters | `([A-Z]+)` |
| `{x:n}` | number with thousands separators | `(\d+(?:,\d+)*)` |

## Testing

```bash
# TypeScript unit tests (stepMatcher, formatter)
npm test

# Python unit tests (step_parser)
python -m pytest server/python/tests/
```

## Packaging as a `.vsix`

```bash
npm install -g @vscode/vsce
vsce package
```

This produces `stepwise-0.1.0.vsix` which you can install via  
**Extensions → … → Install from VSIX…**

/**
 * stubGenerator.ts — pure helpers for synthesising a Python step-definition
 * stub from the text of an unresolved Gherkin step, and for slotting it
 * (plus any required imports) into an existing Python file.
 *
 * Kept free of `vscode` so it can be unit-tested directly.
 */

export type StepKeyword = 'given' | 'when' | 'then';

export interface BuildStubInput {
  /** The step text as it appears in the .feature file, after the keyword. */
  stepText: string;
  /** The decorator keyword to generate ("given" | "when" | "then"). */
  keyword: StepKeyword;
}

export interface BuildStubResult {
  /** The pattern string that goes inside the decorator call. */
  pattern: string;
  /** Generated Python function name. */
  functionName: string;
  /** Parameter list rendered as a comma-joined string (with type hints). */
  paramList: string;
  /** The complete stub: decorator + def + body, ending with a newline. */
  code: string;
}

/** Map pytest-bdd format codes to Python type hints. */
const TYPE_HINT_MAP: Record<string, string> = {
  d: 'int',
  D: 'str',
  f: 'float',
  e: 'float',
  g: 'float',
  w: 'str',
  l: 'str',
  u: 'str',
  s: 'str',
  S: 'str',
  n: 'int',
};

/** Reserved Python keywords — never produce one of these as a parameter name. */
const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await',
  'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is',
  'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield',
]);

/**
 * Build a step-definition stub from an unresolved Gherkin step.
 *
 * Placeholder handling:
 *   - `<name>`        → `{name}` in the pattern, `name: str` parameter
 *   - `{name}`        → preserved, `name: str` parameter
 *   - `{name:type}`   → preserved, parameter typed via TYPE_HINT_MAP
 *
 * Anything else in the step text is treated as a literal (no parameters
 * are inferred from concrete values).
 */
export function buildStub({ stepText, keyword }: BuildStubInput): BuildStubResult {
  const text = stepText.trim();

  // Single-pass conversion: angle-bracket and brace placeholders are both
  // normalised to `{sanitized}` / `{sanitized:type}`. Doing this in one pass
  // preserves document order, which the function signature must match.
  const COMBINED_RE = /<([^>]+)>|\{([^}:]+)(?::([^}]+))?\}/g;
  const occurrences: { name: string; type?: string }[] = [];
  const pattern = text.replace(
    COMBINED_RE,
    (_m, angle: string | undefined, brace: string | undefined, type: string | undefined) => {
      const rawName = angle ?? brace ?? '';
      const name = sanitizeParamName(rawName);
      const t = type?.trim();
      occurrences.push({ name, type: t });
      return t ? `{${name}:${t}}` : `{${name}}`;
    },
  );

  // Dedupe while preserving order of first appearance.
  const seen = new Set<string>();
  const params: typeof occurrences = [];
  for (const p of occurrences) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    params.push(p);
  }

  const functionName = slugify(pattern);
  const paramList = params
    .map((p) => {
      const hint = p.type ? TYPE_HINT_MAP[p.type] : 'str';
      return hint ? `${p.name}: ${hint}` : p.name;
    })
    .join(', ');

  const escaped = pattern.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const code =
    `@${keyword}("${escaped}")\n` +
    `def ${functionName}(${paramList}):\n` +
    `    raise NotImplementedError\n`;

  return { pattern, functionName, paramList, code };
}

/** Coerce arbitrary text into a snake_case Python identifier. */
function slugify(text: string): string {
  // Drop the type half of `{name:type}` so it doesn't pollute the name.
  const noTypes = text.replace(/\{([^}:]+)(?::[^}]+)?\}/g, '$1');
  const base = noTypes
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  if (!base) return 'step_impl';
  // Identifiers can't start with a digit
  return /^\d/.test(base) ? `_${base}` : base;
}

/** Coerce a placeholder name into a valid Python identifier. */
function sanitizeParamName(raw: string): string {
  let name = raw.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  if (!name) name = 'arg';
  if (/^\d/.test(name)) name = `_${name}`;
  if (PY_KEYWORDS.has(name)) name = `${name}_`;
  return name;
}

// ─── Insertion-point detection ────────────────────────────────────────────────

const STEP_DEC_RE = /^@(?:pytest_bdd\.)?(?:given|when|then)\b/;

/**
 * Return the 0-based line index where a new top-level definition should be
 * inserted in `fileText`. The new content will go *before* the returned line
 * (insert at column 0 of that line). A value equal to the total line count
 * means "append at end of file".
 *
 * Strategy:
 *   1. If the file already contains at least one `@given/@when/@then`,
 *      insert right after the function that follows the *last* such decorator.
 *      "After" is the next top-level line that isn't part of the function
 *      body (i.e. first non-blank, non-comment line at column 0).
 *   2. Otherwise insert at the end of file.
 */
export function findInsertionLine(fileText: string): number {
  const lines = fileText.split(/\r?\n/);

  let lastDecIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (STEP_DEC_RE.test(lines[i])) lastDecIdx = i;
  }

  if (lastDecIdx === -1) {
    return lines.length;
  }

  // Skip any chained decorators sitting on top of each other.
  let j = lastDecIdx;
  while (j < lines.length && /^@/.test(lines[j])) j++;
  // j now points at the `def …` line (or past EOF on a malformed file).
  // Walk forward until we leave the function body — first line at column 0
  // that is not blank.
  for (let k = j + 1; k < lines.length; k++) {
    const l = lines[k];
    if (l.length === 0) continue;
    if (/^\s/.test(l)) continue;
    return k;
  }
  return lines.length;
}

// ─── Import maintenance ───────────────────────────────────────────────────────

export interface ImportEdit {
  /** 0-based line index at which to apply the edit. */
  line: number;
  /**
   * If "replace", the entire `lines[line]` is replaced with `text`.
   * If "insert", a new line containing `text` is inserted *before* `lines[line]`.
   */
  kind: 'replace' | 'insert';
  text: string;
}

/**
 * Inspect `fileText` and return the edit needed (if any) so that `keyword`
 * is importable from `pytest_bdd`. Returns null when the import is already
 * present.
 */
export function ensurePytestBddImport(
  fileText: string,
  keyword: StepKeyword,
): ImportEdit | null {
  const lines = fileText.split(/\r?\n/);
  const importRe = /^from\s+pytest_bdd\s+import\s+(.+?)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const m = importRe.exec(lines[i]);
    if (!m) continue;

    const existing = m[1]
      .replace(/[()]/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const baseNames = existing.map((s) => s.replace(/\s+as\s+\w+\s*$/, '').trim());
    if (baseNames.includes(keyword)) return null;

    const updated = [...existing, keyword].sort((a, b) =>
      a.replace(/\s+as\s+\w+\s*$/, '').localeCompare(b.replace(/\s+as\s+\w+\s*$/, '')),
    );
    return {
      line: i,
      kind: 'replace',
      text: `from pytest_bdd import ${updated.join(', ')}`,
    };
  }

  // No existing pytest_bdd import — insert one after the file's leading
  // docstring and existing import block.
  const insertLine = findImportInsertionLine(lines);
  return {
    line: insertLine,
    kind: 'insert',
    text: `from pytest_bdd import ${keyword}`,
  };
}

/**
 * Find the line at which a new `from … import …` should be inserted, given
 * the file already split into lines.
 *
 * Skips:
 *   - leading blank lines
 *   - a top-of-file `#!shebang` and `# coding:` line
 *   - the module docstring (single- or triple-quoted)
 *   - existing contiguous `import …` / `from … import …` block
 */
function findImportInsertionLine(lines: string[]): number {
  let i = 0;

  // Shebang / coding declaration
  while (i < lines.length && /^#/.test(lines[i].trim())) i++;
  // Skip blanks
  while (i < lines.length && lines[i].trim() === '') i++;

  // Module docstring
  if (i < lines.length) {
    const t = lines[i].trim();
    const delim = t.startsWith('"""') ? '"""' : t.startsWith("'''") ? "'''" : null;
    if (delim) {
      // Single-line docstring like """foo"""
      if (t.length > delim.length * 2 - 1 && t.endsWith(delim) && t !== delim) {
        i++;
      } else {
        i++;
        while (i < lines.length && !lines[i].includes(delim)) i++;
        if (i < lines.length) i++; // step past the closing delim line
      }
    }
  }

  // Skip blanks
  while (i < lines.length && lines[i].trim() === '') i++;

  // Walk through any existing imports
  const IMPORT_RE = /^(?:from\s+\S+\s+import\b|import\s+\S)/;
  let lastImportLine = -1;
  while (i < lines.length) {
    const t = lines[i].trim();
    if (IMPORT_RE.test(t)) {
      lastImportLine = i;
      i++;
      continue;
    }
    if (t === '') {
      i++;
      continue;
    }
    break;
  }

  return lastImportLine >= 0 ? lastImportLine + 1 : i;
}

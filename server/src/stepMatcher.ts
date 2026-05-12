/**
 * stepMatcher.ts
 *
 * Utilities for:
 *  - Converting pytest-bdd step patterns (which use {param} / {param:type} syntax)
 *    into JavaScript RegExp objects.
 *  - Matching a step text string against a list of known StepDefinitions.
 *  - Parsing a Gherkin step line into its keyword + text parts.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepDefinition {
  /** The raw pattern string as extracted from source (e.g. "I have {count:d} cucumbers") */
  pattern: string;
  /** Absolute path to the Python file that contains this step */
  file: string;
  /** 1-based line number of the decorated function */
  line: number;
  /** The decorator name: "given" | "when" | "then" */
  decorator: string;
  /**
   * True when the pattern came from re.compile(r"...") — it is a raw Python
   * regex rather than a cfparse/parse format string.
   */
  isRegex?: boolean;
}

// ─── Pattern → RegExp conversion ──────────────────────────────────────────────

/**
 * Format specifier → capturing-group regex fragment.
 * Matches the pytest-bdd / parse library type codes.
 */
const FORMAT_MAP: Record<string, string> = {
  d: '(\\d+)',           // integer
  D: '(\\D+)',           // non-digit
  f: '([-+]?\\d*\\.\\d+)', // float
  e: '([-+]?\\d*\\.?\\d+[eE][-+]?\\d+)', // scientific
  g: '([-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?)', // general number
  w: '(\\w+)',           // word (letters/digits/underscore)
  l: '([a-z]+)',         // lower-case letters
  u: '([A-Z]+)',         // upper-case letters
  s: '(\\S+)',           // non-whitespace token
  S: '(.+)',             // any string including spaces (greedy)
  n: '(\\d+(?:,\\d+)*)', // number with optional thousands separators
};

/**
 * Escape all regex special characters in a literal string fragment.
 * We do NOT escape `{` and `}` here — those are stripped before we reach this
 * function (parameters are handled separately).
 */
function escapeRegexLiteral(s: string): string {
  return s.replace(/[.+*?^$|[\]\\()]/g, '\\$&');
}

/**
 * Convert a pytest-bdd step pattern string into a compiled RegExp.
 *
 * Supported placeholder forms:
 *   {name}       → (.+)      (any text, greedy)
 *   {name:d}     → (\d+)
 *   {name:f}     → float regex
 *   {name:w}     → (\w+)
 *   {name:g}     → general number
 *   … (see FORMAT_MAP for the full list)
 *
 * The resulting regex is anchored (^ … $) and case-insensitive.
 */
const patternCache = new Map<string, RegExp>();

export function patternToRegex(pattern: string): RegExp {
  const cached = patternCache.get(pattern);
  if (cached) return cached;

  // Split the pattern on every {placeholder} token.
  // The capturing group keeps the delimiters in the result array.
  const tokens = pattern.split(/(\{[^}]*\})/g);
  let regexStr = '';

  for (const token of tokens) {
    if (token.startsWith('{') && token.endsWith('}')) {
      // Parameter placeholder: {name} or {name:type}
      const inner = token.slice(1, -1).trim(); // strip braces
      const colonIdx = inner.indexOf(':');
      const typeCode = colonIdx >= 0 ? inner.slice(colonIdx + 1).trim() : '';

      if (typeCode && FORMAT_MAP[typeCode] !== undefined) {
        regexStr += FORMAT_MAP[typeCode];
      } else {
        // Unknown or no type → match any non-empty string
        regexStr += '(.+)';
      }
    } else {
      // Literal text — escape before adding to regex
      regexStr += escapeRegexLiteral(token);
    }
  }

  // Case-insensitive so "Given" / "GIVEN" etc. don't matter at the call site,
  // but mostly we match step text which is already stripped of the keyword.
  const re = new RegExp('^' + regexStr + '$', 'i');
  patternCache.set(pattern, re);
  return re;
}

// ─── Regex pattern display ────────────────────────────────────────────────────

/**
 * Convert a raw Python regex pattern to a human-readable label suitable for
 * display in completion suggestions and documentation.
 *
 * The function strips regex anchors and converts common capturing-group forms
 * to readable `{type}` placeholders.  It is intentionally conservative:
 * unusual constructs are left unchanged rather than mangled.
 *
 * Examples:
 *   "^I eat (\\d+) cucumbers?$"          → "I eat {number} cucumbers?"
 *   "I have (\\d+\\.\\d+) items"         → "I have {decimal} items"
 *   "(?P<name>\\w+) logs in"             → "{name} logs in"
 *   "the (\\w+) is (\\S+)"              → "the {word} is {token}"
 */
export function prettifyRegexPattern(raw: string): string {
  return raw
    // Strip leading ^ and trailing $ anchors
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    // Named capturing groups: (?P<name>...) → {name}
    .replace(/\(\?P<(\w+)>[^)]*\)/g, '{$1}')
    // Float before integer so (\d+\.\d+) doesn't partially match (\d+)
    .replace(/\(\\d\+\\.\\d\+\)/g, '{decimal}')
    // Integer groups
    .replace(/\(\\d\+\)/g, '{number}')
    .replace(/\(\\d\*\)/g, '{number}')
    // Word / token groups
    .replace(/\(\\w\+\)/g, '{word}')
    .replace(/\(\\S\+\)/g, '{token}')
    // Wildcard groups (.+) / (.+?) / (.*) / (.*?)
    .replace(/\(\.\+\??\)/g, '{text}')
    .replace(/\(\.\*\??\)/g, '{text}')
    // Character-class groups like ([^"]+), ([^,]+)
    .replace(/\(\[[\^][^\]]*\]\+\)/g, '{text}')
    .trim();
}

// ─── Step matching ─────────────────────────────────────────────────────────────

/**
 * Try to match `stepText` (the part of the Gherkin line after the keyword)
 * against every StepDefinition.  Returns the first match or undefined.
 */
export function matchStep(
  stepText: string,
  definitions: StepDefinition[]
): StepDefinition | undefined {
  const normalized = stepText.trim();
  for (const def of definitions) {
    let regex: RegExp;
    try {
      regex = patternToRegex(def.pattern);
    } catch {
      // Malformed pattern — skip silently
      continue;
    }
    if (regex.test(normalized)) {
      return def;
    }
  }
  return undefined;
}

// ─── Gherkin line parsing ──────────────────────────────────────────────────────

// Trailing `\s*` is essential on CRLF files: JS regex `.` does not match `\r`,
// so without it lines like "When …\r" never matched and were silently treated
// as non-step lines.
const STEP_KEYWORD_RE =
  /^(\s*)(Given|When|Then|And|But)(\s+)(.+?)\s*$/i;

export interface ParsedStep {
  /** The raw keyword as it appears in the source (e.g. "Given", "When") */
  keyword: string;
  /** Everything after the keyword + whitespace */
  text: string;
  /** Character offset (0-based) where the keyword starts in the line */
  keywordStart: number;
  /** Character offset (0-based) where the step text starts */
  textStart: number;
}

/**
 * Parse a single Gherkin line and return the step keyword + text, or null if
 * this line is not a step line.
 */
export function parseStepLine(line: string): ParsedStep | null {
  const m = STEP_KEYWORD_RE.exec(line);
  if (!m) return null;

  const indent = m[1];
  const keyword = m[2];
  const space = m[3];
  const text = m[4].trim();

  return {
    keyword,
    text,
    keywordStart: indent.length,
    textStart: indent.length + keyword.length + space.length,
  };
}

// ─── Scenario Outline matching ────────────────────────────────────────────────

const OUTLINE_PLACEHOLDER_RE = /<[^>]+>/g;
const HAS_OUTLINE_PLACEHOLDER = /<[^>]+>/;

/**
 * Match a Scenario Outline step whose text contains `<placeholder>` tokens.
 *
 * Instead of testing the step text against each definition's compiled regex
 * (which would fail because `<count>` doesn't look like `\d+`), we invert the
 * direction: build a regex *from* the step text where every `<placeholder>`
 * becomes `.+`, then test each definition's *pattern string* against it.
 *
 * Example:
 *   stepText  = "I have <count> items in my cart"
 *   fragments = ["I have ", " items in my cart"]
 *   outlineRe = /^I have .+ items in my cart$/i
 *   pattern   = "I have {count:d} items in my cart"  → matches ✓
 */
export function matchOutlineStep(
  stepText: string,
  definitions: StepDefinition[],
): StepDefinition | undefined {
  const fragments = stepText.split(OUTLINE_PLACEHOLDER_RE).map(escapeRegexLiteral);
  // Need at least one placeholder for the join to produce a wildcard
  if (fragments.length < 2) return undefined;
  const outlineRe = new RegExp('^' + fragments.join('.+') + '$', 'i');

  for (const def of definitions) {
    if (outlineRe.test(def.pattern)) {
      return def;
    }
  }
  return undefined;
}

/**
 * Match a step line against the known definitions, automatically choosing
 * outline matching when the step text contains `<placeholder>` tokens.
 */
export function resolveStep(
  stepText: string,
  definitions: StepDefinition[],
): StepDefinition | undefined {
  if (HAS_OUTLINE_PLACEHOLDER.test(stepText)) {
    return matchOutlineStep(stepText, definitions);
  }
  return matchStep(stepText, definitions);
}

// ─── Completion helpers ────────────────────────────────────────────────────────

/**
 * Filter `definitions` whose patterns contain `query` as a substring
 * (case-insensitive), returning at most `limit` results.
 */
export function filterDefinitions(
  query: string,
  definitions: StepDefinition[],
  limit = 50
): StepDefinition[] {
  const lower = query.toLowerCase();
  const results: StepDefinition[] = [];
  for (const def of definitions) {
    // For regex patterns, search both the raw pattern and the prettified label
    // so that typing "number" or "eat 5" can both surface the same definition.
    const searchable = def.isRegex
      ? def.pattern.toLowerCase() + ' ' + prettifyRegexPattern(def.pattern).toLowerCase()
      : def.pattern.toLowerCase();
    if (searchable.includes(lower)) {
      results.push(def);
      if (results.length >= limit) break;
    }
  }
  return results;
}

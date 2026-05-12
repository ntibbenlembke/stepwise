import {
  buildStub,
  ensurePytestBddImport,
  findInsertionLine,
} from '../client/src/stubGenerator';

// ── buildStub ────────────────────────────────────────────────────────────────

describe('buildStub', () => {
  it('generates a parameterless stub for plain step text', () => {
    const r = buildStub({ stepText: 'I open the page', keyword: 'given' });
    expect(r.pattern).toBe('I open the page');
    expect(r.functionName).toBe('i_open_the_page');
    expect(r.paramList).toBe('');
    expect(r.code).toBe(
      '@given("I open the page")\n' +
        'def i_open_the_page():\n' +
        '    raise NotImplementedError\n',
    );
  });

  it('handles `{name:type}` placeholders with typed parameters', () => {
    const r = buildStub({
      stepText: 'I have {count:d} cucumbers and {price:f} dollars',
      keyword: 'given',
    });
    expect(r.pattern).toBe('I have {count:d} cucumbers and {price:f} dollars');
    expect(r.paramList).toBe('count: int, price: float');
    expect(r.functionName).toBe('i_have_count_cucumbers_and_price_dollars');
  });

  it('treats untyped `{name}` placeholders as strings', () => {
    const r = buildStub({ stepText: 'I click the {label} button', keyword: 'when' });
    expect(r.paramList).toBe('label: str');
    expect(r.code).toContain('@when("I click the {label} button")');
  });

  it('converts Scenario Outline `<name>` to `{name}` and emits a parameter', () => {
    const r = buildStub({ stepText: 'I have <count> cucumbers', keyword: 'given' });
    expect(r.pattern).toBe('I have {count} cucumbers');
    expect(r.paramList).toBe('count: str');
  });

  it('escapes embedded quotes and backslashes in the pattern', () => {
    const r = buildStub({
      stepText: 'I see "hello" and a \\ backslash',
      keyword: 'then',
    });
    expect(r.code).toContain(
      '@then("I see \\"hello\\" and a \\\\ backslash")',
    );
  });

  it('emits parameters in document order regardless of placeholder syntax', () => {
    const r = buildStub({
      stepText: 'I add {a:d} then <b> then {c:d}',
      keyword: 'when',
    });
    expect(r.paramList).toBe('a: int, b: str, c: int');
    expect(r.pattern).toBe('I add {a:d} then {b} then {c:d}');
  });

  it('deduplicates repeated placeholder names', () => {
    const r = buildStub({
      stepText: 'I add {x:d} and {x:d} to get {y:d}',
      keyword: 'when',
    });
    expect(r.paramList).toBe('x: int, y: int');
  });

  it('sanitises placeholder names that are not valid identifiers', () => {
    const r = buildStub({
      stepText: 'I do <some-thing> with <2nd-arg>',
      keyword: 'given',
    });
    expect(r.paramList).toBe('some_thing: str, _2nd_arg: str');
    expect(r.pattern).toBe('I do {some_thing} with {_2nd_arg}');
  });

  it('avoids Python keywords as parameter names', () => {
    const r = buildStub({ stepText: 'I check <class>', keyword: 'then' });
    expect(r.paramList).toBe('class_: str');
  });

  it('falls back to step_impl when no usable name characters remain', () => {
    const r = buildStub({ stepText: '!!!', keyword: 'given' });
    expect(r.functionName).toBe('step_impl');
  });

  it('prefixes the name with an underscore when it would start with a digit', () => {
    const r = buildStub({ stepText: '3 things happen', keyword: 'when' });
    expect(r.functionName).toBe('_3_things_happen');
  });
});

// ── findInsertionLine ────────────────────────────────────────────────────────

describe('findInsertionLine', () => {
  it('returns line count for an empty file', () => {
    expect(findInsertionLine('')).toBe(1);
  });

  it('appends to end when no step decorators are present', () => {
    const text = 'def helper():\n    return 1\n';
    expect(findInsertionLine(text)).toBe(text.split('\n').length);
  });

  it('inserts after the last @given/@when/@then function body', () => {
    const text =
      'from pytest_bdd import given, when\n' +
      '\n' +
      '@given("a")\n' +
      'def step_a():\n' +
      '    pass\n' +
      '\n' +
      '@when("b")\n' +
      'def step_b():\n' +
      '    do_something()\n' +
      '    return 1\n' +
      '\n' +
      'def helper():\n' +
      '    return 2\n';
    // Should land on the blank line just *before* `def helper`, which is the
    // first non-blank top-level line after the last step function.
    const idx = findInsertionLine(text);
    const lines = text.split('\n');
    expect(lines[idx]).toBe('def helper():');
  });

  it('returns end-of-file when the last step definition has no trailing content', () => {
    const text =
      '@given("a")\n' +
      'def step_a():\n' +
      '    pass\n';
    expect(findInsertionLine(text)).toBe(text.split('\n').length);
  });

  it('handles a fully-qualified @pytest_bdd.given decorator', () => {
    const text =
      '@pytest_bdd.given("a")\n' +
      'def step_a():\n' +
      '    pass\n' +
      '\n' +
      'OTHER = 1\n';
    const idx = findInsertionLine(text);
    expect(text.split('\n')[idx]).toBe('OTHER = 1');
  });
});

// ── ensurePytestBddImport ────────────────────────────────────────────────────

describe('ensurePytestBddImport', () => {
  it('returns null when the keyword is already imported', () => {
    const text = 'from pytest_bdd import given, when\n';
    expect(ensurePytestBddImport(text, 'given')).toBeNull();
    expect(ensurePytestBddImport(text, 'when')).toBeNull();
  });

  it('merges into an existing import line when keyword is missing', () => {
    const text = 'from pytest_bdd import given\n';
    const edit = ensurePytestBddImport(text, 'then');
    expect(edit).not.toBeNull();
    expect(edit!.kind).toBe('replace');
    expect(edit!.line).toBe(0);
    expect(edit!.text).toBe('from pytest_bdd import given, then');
  });

  it('keeps merged imports alphabetised', () => {
    const text = 'from pytest_bdd import when, given\n';
    const edit = ensurePytestBddImport(text, 'then');
    expect(edit!.text).toBe('from pytest_bdd import given, then, when');
  });

  it('inserts a fresh import after the existing import block', () => {
    const text =
      'import os\n' +
      'from pathlib import Path\n' +
      '\n' +
      'def helper():\n' +
      '    pass\n';
    const edit = ensurePytestBddImport(text, 'given');
    expect(edit).not.toBeNull();
    expect(edit!.kind).toBe('insert');
    // After the two existing imports — line index 2 (0-based).
    expect(edit!.line).toBe(2);
    expect(edit!.text).toBe('from pytest_bdd import given');
  });

  it('inserts after a single-line module docstring', () => {
    const text =
      '"""A docstring."""\n' +
      'def helper():\n' +
      '    pass\n';
    const edit = ensurePytestBddImport(text, 'given');
    expect(edit!.kind).toBe('insert');
    expect(edit!.line).toBe(1);
  });

  it('inserts after a triple-quoted multi-line module docstring', () => {
    const text =
      '"""\n' +
      'A multi-line docstring.\n' +
      '"""\n' +
      'def helper():\n' +
      '    pass\n';
    const edit = ensurePytestBddImport(text, 'when');
    expect(edit!.kind).toBe('insert');
    expect(edit!.line).toBe(3);
  });

  it('handles parenthesised import lists', () => {
    const text = 'from pytest_bdd import (given, when)\n';
    const edit = ensurePytestBddImport(text, 'then');
    expect(edit).not.toBeNull();
    expect(edit!.text).toBe('from pytest_bdd import given, then, when');
  });

  it('respects `import x as y` aliases when checking for an existing import', () => {
    const text = 'from pytest_bdd import given as g, when\n';
    // `given` is imported (as `g`); the alias should still count.
    expect(ensurePytestBddImport(text, 'given')).toBeNull();
  });
});

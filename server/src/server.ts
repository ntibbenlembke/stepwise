declare const __VERSION__: string;

/**
 * server.ts — Stepwise LSP server
 *
 * Responsibilities:
 *  1. On startup: scan workspace Python files, invoke step_parser.py subprocess,
 *     build an in-memory index of step definitions.
 *  2. Watch for Python file changes and refresh the index.
 *  3. Provide diagnostics (warning squiggle) for unmatched Gherkin steps.
 *  4. Provide go-to-definition for step lines.
 *  5. Provide completion suggestions as the user types a step line.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';

import {
  createConnection,
  TextDocuments,
  Diagnostic,
  DiagnosticSeverity,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  DidChangeWatchedFilesNotification,
  CompletionItem,
  CompletionItemKind,
  TextDocumentPositionParams,
  DefinitionParams,
  LocationLink,
  Range,
  WatchKind,
  SemanticTokens,
  SemanticTokensParams,
  DidChangeConfigurationNotification,
  DocumentFormattingParams,
  TextEdit,
} from 'vscode-languageserver/node';

import { TextDocument } from 'vscode-languageserver-textdocument';

import {
  StepDefinition,
  resolveStep,
  parseStepLine,
  filterDefinitions,
  prettifyRegexPattern,
} from './stepMatcher';

import { formatDocument } from './formatter';

// ─── Globals ──────────────────────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

let workspaceFolderPaths: string[] = [];
let stepDefinitions: StepDefinition[] = [];
let extensionPath: string | undefined;

// Track whether the client supports dynamic file-watcher registration
let supportsDynamicWatchers = false;

// ─── Configuration ────────────────────────────────────────────────────────────

interface StepwiseConfig {
  stepDefinitionPaths: string[];
  pythonPath: string;
}

async function getConfig(): Promise<StepwiseConfig> {
  const raw = await connection.workspace.getConfiguration('stepwise');
  return {
    stepDefinitionPaths: Array.isArray(raw?.stepDefinitionPaths) ? raw.stepDefinitionPaths : [],
    pythonPath: typeof raw?.pythonPath === 'string' ? raw.pythonPath.trim() : '',
  };
}

// ─── Semantic token legend ────────────────────────────────────────────────────
// Index 0: "stepResolved" — step text with a matching definition.
// Index 1: "keyword"      — Given / When / Then / And / But keyword.
const TOKEN_LEGEND = {
  tokenTypes: ['stepResolved', 'keyword'],
  tokenModifiers: [] as string[],
};

// ─── URI / path helpers ───────────────────────────────────────────────────────

/** Convert a `file://` URI to a local file-system path. */
function uriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    let p = decodeURIComponent(url.pathname);
    // On Windows the pathname looks like /C:/Users/... — strip the leading slash.
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) {
      p = p.slice(1);
    }
    return p;
  } catch {
    // Fallback: strip scheme manually
    return uri.replace(/^file:\/\//, '');
  }
}

/** Convert a local file-system path to a `file://` URI. */
function pathToUri(filePath: string): string {
  if (process.platform === 'win32') {
    return 'file:///' + filePath.replace(/\\/g, '/');
  }
  return 'file://' + filePath;
}

// ─── File discovery ────────────────────────────────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv',
  '.mypy_cache', '.pytest_cache', 'dist', 'build', '.tox',
]);

/**
 * Recursively collect every `.py` file under `root`.
 * Skips common non-source directories for performance.
 */
function findPythonFiles(root: string): string[] {
  const results: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Unreadable directory — skip
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          walk(full);
        }
      } else if (entry.isFile() && entry.name.endsWith('.py')) {
        results.push(full);
      }
    }
  }

  walk(root);
  return results;
}

// ─── Python subprocess ────────────────────────────────────────────────────────

/** Try to find a usable Python 3 interpreter. Uses `configured` path if provided. */
function findPython(configured?: string): string {
  const candidates = configured ? [configured, 'python3', 'python'] : ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      const result = cp.spawnSync(candidate, ['--version'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      if (result.status === 0) {
        const out = (result.stdout || result.stderr || '').trim();
        if (out.startsWith('Python 3')) {
          return candidate;
        }
      }
    } catch {
      // not found
    }
  }
  return configured || 'python3'; // best guess
}

/** Absolute path to the bundled step_parser.py. */
function getParserScriptPath(): string {
  if (extensionPath) {
    return path.join(extensionPath, 'server', 'python', 'step_parser.py');
  }
  // Fallback for environments where extensionPath wasn't passed (e.g. tests).
  // Compiled output lives at out/server/server.js, two levels up from the root.
  return path.join(__dirname, '..', '..', 'server', 'python', 'step_parser.py');
}

/**
 * Invoke step_parser.py with a JSON array of Python file paths on stdin.
 * Returns a parsed array of StepDefinition objects.
 */
function runStepParser(pythonFiles: string[], pythonPath?: string): Promise<StepDefinition[]> {
  return new Promise((resolve) => {
    if (pythonFiles.length === 0) {
      resolve([]);
      return;
    }

    const scriptPath = getParserScriptPath();

    if (!fs.existsSync(scriptPath)) {
      connection.console.warn(`[stepwise] Parser script not found at: ${scriptPath}`);
      resolve([]);
      return;
    }

    const python = findPython(pythonPath);
    const proc = cp.spawn(python, [scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    proc.on('error', (err: Error) => {
      connection.console.warn(`[stepwise] Failed to spawn Python: ${err.message}`);
      resolve([]);
    });

    proc.on('close', (code: number | null) => {
      if (code !== 0) {
        connection.console.warn(
          `[stepwise] step_parser.py exited with code ${code}. stderr: ${stderr.slice(0, 400)}`
        );
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as StepDefinition[];
        resolve(parsed);
      } catch (e) {
        connection.console.warn(`[stepwise] Failed to parse JSON from step_parser.py: ${e}`);
        resolve([]);
      }
    });

    proc.stdin.write(JSON.stringify(pythonFiles), 'utf8');
    proc.stdin.end();
  });
}

// ─── Index management ─────────────────────────────────────────────────────────

async function refreshStepDefinitions(): Promise<void> {
  const config = await getConfig();

  // Resolve search roots: configured paths (relative to each workspace root, or
  // absolute) take priority; fall back to the workspace roots themselves.
  const searchRoots: string[] = [];
  if (config.stepDefinitionPaths.length > 0) {
    for (const folder of workspaceFolderPaths) {
      for (const p of config.stepDefinitionPaths) {
        const resolved = path.isAbsolute(p) ? p : path.join(folder, p);
        if (fs.existsSync(resolved)) {
          searchRoots.push(resolved);
        } else {
          connection.console.warn(`[stepwise] stepDefinitionPaths entry not found: ${resolved}`);
        }
      }
    }
  } else {
    searchRoots.push(...workspaceFolderPaths);
  }

  const allPyFiles: string[] = [];
  for (const root of searchRoots) {
    allPyFiles.push(...findPythonFiles(root));
  }

  connection.console.log(
    `[stepwise] Scanning ${allPyFiles.length} Python file(s) for step definitions…`
  );

  stepDefinitions = await runStepParser(allPyFiles, config.pythonPath || undefined);

  connection.console.log(
    `[stepwise] Loaded ${stepDefinitions.length} step definition(s).`
  );

  // Re-validate all currently open feature files and refresh semantic colours
  for (const doc of documents.all()) {
    validateDocument(doc);
  }
  // Ask the client to re-request semantic tokens for all open documents
  connection.languages.semanticTokens.refresh();
}

// ─── Diagnostics ──────────────────────────────────────────────────────────────

function validateDocument(doc: TextDocument): void {
  if (!doc.uri.endsWith('.feature')) return;

  const diagnostics: Diagnostic[] = [];
  const text = doc.getText();
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parsed = parseStepLine(line);
    if (!parsed) continue;

    const match = resolveStep(parsed.text, stepDefinitions);
    if (!match) {
      const range: Range = {
        start: { line: i, character: parsed.keywordStart },
        end: { line: i, character: line.trimEnd().length },
      };
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range,
        message: `No matching step definition found for: "${parsed.text}"`,
        source: 'stepwise',
        code: 'no-step-definition',
      });
    }
  }

  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

connection.onInitialize((params: InitializeParams): InitializeResult => {
  // Collect workspace root paths
  if (params.workspaceFolders) {
    workspaceFolderPaths = params.workspaceFolders.map((f) => uriToPath(f.uri));
  } else if (params.rootUri) {
    workspaceFolderPaths = [uriToPath(params.rootUri)];
  } else if (params.rootPath) {
    workspaceFolderPaths = [params.rootPath];
  }

  // Extension root passed from the client — used to locate step_parser.py
  // reliably regardless of how the output is structured.
  extensionPath = params.initializationOptions?.extensionPath as string | undefined;

  supportsDynamicWatchers =
    !!params.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration;

  const result: InitializeResult = {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: [' '],
      },
      definitionProvider: true,
      semanticTokensProvider: {
        legend: TOKEN_LEGEND,
        range: false,
        full: true,
      },
      documentFormattingProvider: true,
    },
    serverInfo: {
      name: 'stepwise',
      version: __VERSION__,
    },
  };

  return result;
});

connection.onInitialized(async () => {
  if (supportsDynamicWatchers) {
    // Ask VS Code to deliver file-change events for Python files
    await connection.client.register(DidChangeWatchedFilesNotification.type, {
      watchers: [
        {
          globPattern: '**/*.py',
          kind: WatchKind.Create | WatchKind.Change | WatchKind.Delete,
        },
      ],
    });
  }

  // Re-index whenever the user changes stepwise settings
  await connection.client.register(DidChangeConfigurationNotification.type, {
    section: 'stepwise',
  });

  await refreshStepDefinitions();
});

connection.onDidChangeConfiguration(async () => {
  await refreshStepDefinitions();
});

// ─── File watcher ─────────────────────────────────────────────────────────────

connection.onDidChangeWatchedFiles(async (params) => {
  const hasPyChange = params.changes.some((c) => c.uri.endsWith('.py'));
  if (hasPyChange) {
    await refreshStepDefinitions();
  }
});

// ─── Go-to-definition ─────────────────────────────────────────────────────────

connection.onDefinition((params: DefinitionParams): LocationLink[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;

  // Get the full text of the line at the cursor
  const lineText = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: { line: params.position.line, character: Number.MAX_SAFE_INTEGER },
  });

  const parsed = parseStepLine(lineText);
  if (!parsed) return null;

  const def = resolveStep(parsed.text, stepDefinitions);
  if (!def) return null;

  // Highlight the entire step phrase (everything after the keyword) when
  // the user Ctrl+hovers or Ctrl+clicks, not just the word under the cursor.
  const originSelectionRange: Range = {
    start: { line: params.position.line, character: parsed.textStart },
    end:   { line: params.position.line, character: parsed.textStart + parsed.text.length },
  };

  // line in StepDefinition is 1-based; LSP uses 0-based
  const targetLine = Math.max(0, def.line - 1);
  const targetPos = { line: targetLine, character: 0 };

  return [{
    originSelectionRange,
    targetUri: pathToUri(def.file),
    targetRange: { start: targetPos, end: targetPos },
    targetSelectionRange: { start: targetPos, end: targetPos },
  }];
});

// ─── Semantic tokens ──────────────────────────────────────────────────────────
//
// For every step line we emit two tokens (delta-encoded, in document order):
//   1. "keyword" (index 1) — always, covering Given/When/Then/And/But
//   2. "stepResolved" (index 0) — only when the step text matches a definition

connection.languages.semanticTokens.on((params: SemanticTokensParams): SemanticTokens => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || !doc.uri.endsWith('.feature')) {
    return { data: [] };
  }

  const data: number[] = [];
  const lines = doc.getText().split('\n');
  let prevLine = 0;
  let prevChar = 0;

  const push = (line: number, char: number, length: number, type: number) => {
    const deltaLine = line - prevLine;
    const deltaChar = deltaLine === 0 ? char - prevChar : char;
    data.push(deltaLine, deltaChar, length, type, 0);
    prevLine = line;
    prevChar = char;
  };

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseStepLine(lines[i]);
    if (!parsed) continue;

    // 1. Keyword token — always emitted
    push(i, parsed.keywordStart, parsed.keyword.length, 1 /* keyword */);

    // 2. stepResolved token — only for matched steps
    const match = resolveStep(parsed.text, stepDefinitions);
    if (match) {
      push(i, parsed.textStart, parsed.text.length, 0 /* stepResolved */);
    }
  }

  return { data };
});

// ─── Completion ───────────────────────────────────────────────────────────────

connection.onCompletion((params: TextDocumentPositionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];

  // Only look at what's been typed up to the cursor on this line
  const linePrefix = doc.getText({
    start: { line: params.position.line, character: 0 },
    end: params.position,
  });

  // Must be on a step line  (Given/When/Then/And/But …)
  const kwMatch = /^\s*(?:Given|When|Then|And|But)\s+(.*)/i.exec(linePrefix);
  if (!kwMatch) return [];

  const typed = kwMatch[1]; // text the user has typed so far after the keyword
  const candidates = filterDefinitions(typed, stepDefinitions, 60);

  return candidates.map((def, index) => {
    const basename = path.basename(def.file);
    // Regex patterns are displayed with cleaned-up labels; cfparse/plain
    // patterns are shown as-is.
    const displayLabel = def.isRegex ? prettifyRegexPattern(def.pattern) : def.pattern;
    const detailTag    = def.isRegex ? 'regex · ' : '';
    return {
      label: displayLabel,
      kind: CompletionItemKind.Text,
      detail: `${detailTag}${def.decorator} — ${basename}:${def.line}`,
      documentation: {
        kind: 'markdown',
        value: def.isRegex
          ? `**${def.decorator}** *(regex)*\n\`\`\`regex\n${def.pattern}\n\`\`\`\n*Defined in ${def.file}:${def.line}*`
          : `**${def.decorator}**\n\`\`\`\n${def.pattern}\n\`\`\`\n*Defined in ${def.file}:${def.line}*`,
      },
      sortText: String(index).padStart(6, '0'),
      insertText: displayLabel,
    };
  });
});

// ─── Formatting ───────────────────────────────────────────────────────────────

connection.onDocumentFormatting((params: DocumentFormattingParams): TextEdit[] | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc || !doc.uri.endsWith('.feature')) return null;

  const original  = doc.getText();
  const formatted = formatDocument(
    original,
    params.options.tabSize,
    params.options.insertSpaces,
  );

  if (formatted === original) return [];

  return [
    TextEdit.replace(
      { start: { line: 0, character: 0 }, end: doc.positionAt(original.length) },
      formatted,
    ),
  ];
});

// ─── Document listeners ───────────────────────────────────────────────────────

documents.onDidChangeContent((change) => {
  validateDocument(change.document);
});

documents.onDidOpen((event) => {
  validateDocument(event.document);
});

documents.listen(connection);
connection.listen();

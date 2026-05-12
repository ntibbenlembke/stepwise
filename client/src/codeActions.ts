/**
 * codeActions.ts — quick-fix provider that offers to generate a step
 * definition stub for any Gherkin step diagnosed as
 * `code: 'no-step-definition'` by the StepWise language server.
 */

import * as path from 'path';
import * as vscode from 'vscode';

import {
  StepKeyword,
  buildStub,
  ensurePytestBddImport,
  findInsertionLine,
} from './stubGenerator';

export const GENERATE_COMMAND_ID = 'stepwise.generateStepDefinition';

const DIAGNOSTIC_CODE = 'no-step-definition';
const DIAGNOSTIC_SOURCE = 'stepwise';

// Directories that should not be offered as step-def hosts.
const EXCLUDE_GLOB =
  '{**/node_modules/**,**/.git/**,**/__pycache__/**,**/.venv/**,**/venv/**,' +
  '**/.mypy_cache/**,**/.pytest_cache/**,**/dist/**,**/build/**,**/.tox/**}';

interface GenerateArgs {
  /** URI of the .feature file the diagnostic was raised in. */
  documentUri: string;
  /** Line index (0-based) of the unresolved step. */
  line: number;
}

// ─── CodeActionProvider ──────────────────────────────────────────────────────

export class StepDefinitionCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const matches: vscode.Diagnostic[] = [];

    // 1. Diagnostics VS Code already considered overlapping the cursor.
    for (const diag of context.diagnostics) {
      if (isUnresolvedStepDiagnostic(diag)) matches.push(diag);
    }

    // 2. Fall back to any unresolved-step diagnostic on the cursor's line —
    //    `context.diagnostics` filters by range intersection, so a cursor
    //    parked past the trimmed line end won't see the diagnostic otherwise.
    if (matches.length === 0) {
      const cursorLine = range.start.line;
      for (const diag of vscode.languages.getDiagnostics(document.uri)) {
        if (!isUnresolvedStepDiagnostic(diag)) continue;
        if (diag.range.start.line !== cursorLine) continue;
        matches.push(diag);
      }
    }

    return matches.map((diag) => {
      const action = new vscode.CodeAction(
        'Generate step definition',
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diag];
      action.isPreferred = true;
      const args: GenerateArgs = {
        documentUri: document.uri.toString(),
        line: diag.range.start.line,
      };
      action.command = {
        command: GENERATE_COMMAND_ID,
        title: 'Generate step definition',
        arguments: [args],
      };
      return action;
    });
  }
}

/**
 * Diagnostic.code can arrive as a raw string/number OR — when
 * vscode-languageclient negotiates `codeDescriptionSupport` — as
 * `{ value, target }`. Normalise both shapes before comparing.
 */
function isUnresolvedStepDiagnostic(diag: vscode.Diagnostic): boolean {
  if (diag.source !== DIAGNOSTIC_SOURCE) return false;
  const rawCode = diag.code;
  const code =
    typeof rawCode === 'object' && rawCode !== null ? rawCode.value : rawCode;
  return code === DIAGNOSTIC_CODE;
}

// ─── Command implementation ──────────────────────────────────────────────────

export async function generateStepDefinitionCommand(args: GenerateArgs): Promise<void> {
  if (!args || typeof args.documentUri !== 'string' || typeof args.line !== 'number') {
    return;
  }

  let featureDoc: vscode.TextDocument;
  try {
    featureDoc = await vscode.workspace.openTextDocument(vscode.Uri.parse(args.documentUri));
  } catch {
    return;
  }

  if (args.line < 0 || args.line >= featureDoc.lineCount) return;

  const lineText = featureDoc.lineAt(args.line).text;
  const parsed = parseStepLine(lineText);
  if (!parsed) {
    vscode.window.showWarningMessage(
      'StepWise: cursor is not on a step line — cannot generate a step definition.',
    );
    return;
  }

  // And/But inherit the keyword of the preceding Given/When/Then.
  const keyword =
    parsed.keyword === 'and' || parsed.keyword === 'but'
      ? resolveInheritedKeyword(featureDoc, args.line)
      : parsed.keyword;

  const workspaceFolder =
    vscode.workspace.getWorkspaceFolder(featureDoc.uri) ??
    vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage(
      'StepWise: open a folder before generating step definitions.',
    );
    return;
  }

  const target = await pickStepDefinitionFile(workspaceFolder);
  if (!target) return;

  const stub = buildStub({ stepText: parsed.text, keyword });

  if (target.kind === 'new') {
    await createNewStepDefinitionFile(target.uri, keyword, stub.code);
    return;
  }

  await insertIntoExistingFile(target.uri, keyword, stub.code);
}

// ─── Step-line parsing (lives client-side to avoid a server round-trip) ──────

interface ParsedStepLine {
  keyword: 'given' | 'when' | 'then' | 'and' | 'but';
  text: string;
}

function parseStepLine(line: string): ParsedStepLine | null {
  const m = /^\s*(Given|When|Then|And|But)\s+(.+?)\s*$/i.exec(line);
  if (!m) return null;
  return { keyword: m[1].toLowerCase() as ParsedStepLine['keyword'], text: m[2] };
}

function resolveInheritedKeyword(doc: vscode.TextDocument, fromLine: number): StepKeyword {
  for (let i = fromLine - 1; i >= 0; i--) {
    const m = /^\s*(Given|When|Then)\b/i.exec(doc.lineAt(i).text);
    if (m) return m[1].toLowerCase() as StepKeyword;
  }
  return 'given';
}

// ─── File picker ─────────────────────────────────────────────────────────────

type PickResult =
  | { kind: 'existing'; uri: vscode.Uri }
  | { kind: 'new'; uri: vscode.Uri };

async function pickStepDefinitionFile(
  workspaceFolder: vscode.WorkspaceFolder,
): Promise<PickResult | undefined> {
  const config = vscode.workspace.getConfiguration('stepwise', workspaceFolder.uri);
  const configuredPaths = config.get<string[]>('stepDefinitionPaths') ?? [];

  const uris = await discoverPythonFiles(workspaceFolder, configuredPaths);
  const dedup = new Map<string, vscode.Uri>();
  for (const u of uris) dedup.set(u.fsPath, u);
  const sorted = [...dedup.values()].sort((a, b) =>
    a.fsPath.localeCompare(b.fsPath),
  );

  const CREATE_NEW = '__stepwise_create_new__';
  interface Item extends vscode.QuickPickItem {
    target?: vscode.Uri;
    sentinel?: string;
  }

  const items: Item[] = sorted.map((uri) => ({
    label: path.basename(uri.fsPath),
    description: vscode.workspace.asRelativePath(uri, false),
    target: uri,
  }));
  items.push({
    label: '$(file-add) Create new step definition file…',
    sentinel: CREATE_NEW,
    alwaysShow: true,
  });

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Generate step definition',
    placeHolder:
      sorted.length === 0
        ? 'No Python files found — choose to create one'
        : 'Select the Python file to insert the step definition into',
    matchOnDescription: true,
  });

  if (!picked) return undefined;

  if (picked.sentinel === CREATE_NEW) {
    const newUri = await promptForNewFile(workspaceFolder, configuredPaths);
    return newUri ? { kind: 'new', uri: newUri } : undefined;
  }

  return picked.target ? { kind: 'existing', uri: picked.target } : undefined;
}

async function discoverPythonFiles(
  workspaceFolder: vscode.WorkspaceFolder,
  configuredPaths: string[],
): Promise<vscode.Uri[]> {
  if (configuredPaths.length === 0) {
    return vscode.workspace.findFiles(
      new vscode.RelativePattern(workspaceFolder, '**/*.py'),
      EXCLUDE_GLOB,
    );
  }

  const results: vscode.Uri[] = [];
  for (const p of configuredPaths) {
    if (path.isAbsolute(p)) {
      // Absolute paths: use a fs-based pattern. RelativePattern accepts a
      // string base when targeting outside the workspace.
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(p, '**/*.py'),
        EXCLUDE_GLOB,
      );
      results.push(...found);
    } else {
      const glob = `${p.replace(/\\/g, '/').replace(/\/+$/, '')}/**/*.py`;
      const found = await vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder, glob),
        EXCLUDE_GLOB,
      );
      results.push(...found);
    }
  }
  return results;
}

async function promptForNewFile(
  workspaceFolder: vscode.WorkspaceFolder,
  configuredPaths: string[],
): Promise<vscode.Uri | undefined> {
  const firstConfigured = configuredPaths.find((p) => !path.isAbsolute(p));
  const defaultDir = firstConfigured
    ? firstConfigured.replace(/\\/g, '/').replace(/\/+$/, '')
    : 'tests/steps';
  const suggestion = `${defaultDir}/test_steps.py`;

  const entered = await vscode.window.showInputBox({
    title: 'New step definition file',
    prompt: 'Path relative to the workspace root',
    value: suggestion,
    valueSelection: [defaultDir.length + 1, suggestion.length - '.py'.length],
    validateInput: (v) => {
      const trimmed = v.trim();
      if (!trimmed) return 'Path is required';
      if (!trimmed.endsWith('.py')) return 'File must end with .py';
      if (path.isAbsolute(trimmed)) return 'Use a path relative to the workspace root';
      return null;
    },
  });
  if (!entered) return undefined;

  return vscode.Uri.joinPath(workspaceFolder.uri, ...entered.trim().split(/[\\/]/));
}

// ─── File mutation ───────────────────────────────────────────────────────────

async function createNewStepDefinitionFile(
  uri: vscode.Uri,
  keyword: StepKeyword,
  stubCode: string,
): Promise<void> {
  const content =
    `"""Step definitions for pytest-bdd."""\n` +
    `from pytest_bdd import ${keyword}\n\n\n` +
    stubCode;

  try {
    await vscode.workspace.fs.stat(uri);
    vscode.window.showErrorMessage(
      `StepWise: file already exists at ${vscode.workspace.asRelativePath(uri)}. ` +
        'Cancel and pick that file from the list instead.',
    );
    return;
  } catch {
    // File does not exist — good, proceed.
  }

  // Ensure parent directory exists. VS Code's writeFile creates intermediate
  // directories on most file systems, but we call createDirectory explicitly
  // to be safe.
  const parent = vscode.Uri.joinPath(uri, '..');
  try {
    await vscode.workspace.fs.createDirectory(parent);
  } catch {
    // ignored — already exists or unsupported
  }

  await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
  await openAndReveal(uri, stubCode);
}

async function insertIntoExistingFile(
  uri: vscode.Uri,
  keyword: StepKeyword,
  stubCode: string,
): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const fileText = doc.getText();
  const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

  const importEdit = ensurePytestBddImport(fileText, keyword);

  // Compute insertion point AFTER the (potential) import edit so the edit
  // operates on the post-import line numbers if we used pre-edit text — but
  // we apply both edits in a single WorkspaceEdit, so VS Code resolves the
  // positions against the current document. Insertion via Position uses
  // the original document's line numbers, so we compute against `fileText`
  // and apply both edits atomically.
  const insertionLine = findInsertionLine(fileText);

  const workspaceEdit = new vscode.WorkspaceEdit();

  if (importEdit) {
    if (importEdit.kind === 'replace') {
      const range = doc.lineAt(importEdit.line).range;
      workspaceEdit.replace(uri, range, importEdit.text);
    } else {
      const insertPos = new vscode.Position(importEdit.line, 0);
      workspaceEdit.insert(uri, insertPos, importEdit.text + eol);
    }
  }

  // Normalise stub to the document's EOL convention and ensure surrounding
  // blank lines so the new function is visually separated.
  const normalisedStub = stubCode.replace(/\r?\n/g, eol);
  const insertText =
    insertionLine >= doc.lineCount
      ? // Append at EOF — make sure there's a blank line above.
        (doc.lineCount > 0 && doc.lineAt(doc.lineCount - 1).text !== ''
          ? eol + eol
          : eol) + normalisedStub
      : eol + normalisedStub;

  const insertPos =
    insertionLine >= doc.lineCount
      ? new vscode.Position(
          doc.lineCount,
          0,
        )
      : new vscode.Position(insertionLine, 0);

  workspaceEdit.insert(uri, insertPos, insertText);

  const applied = await vscode.workspace.applyEdit(workspaceEdit);
  if (!applied) {
    vscode.window.showErrorMessage('StepWise: failed to insert step definition.');
    return;
  }
  await doc.save();
  await openAndReveal(uri, stubCode);
}

async function openAndReveal(uri: vscode.Uri, stubCode: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  // Position the cursor on the stub body so the user can start typing.
  const text = doc.getText();
  const idx = text.lastIndexOf(stubCode.trimEnd());
  if (idx >= 0) {
    const pos = doc.positionAt(idx + stubCode.trimEnd().length);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
  }
}

import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext): void {
  // The compiled language server entry point
  const serverModule = context.asAbsolutePath(
    path.join('out', 'server', 'server.js')
  );

  // Debug config: attach Node debugger on port 6009 when running under --extensionDevelopmentPath
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ['--nolazy', '--inspect=6009'],
      },
    },
  };

  const clientOptions: LanguageClientOptions = {
    // Activate for Gherkin feature files
    documentSelector: [
      { scheme: 'file', language: 'gherkin' },
    ],
    synchronize: {
      // Notify the server when .feature or .py files change on disk
      fileEvents: [
        vscode.workspace.createFileSystemWatcher('**/*.feature'),
        vscode.workspace.createFileSystemWatcher('**/*.py'),
      ],
      configurationSection: 'stepwise',
    },
    initializationOptions: {
      extensionPath: context.extensionPath,
    },
  };

  client = new LanguageClient(
    'stepwise',
    'StepWise BDD Language Server',
    serverOptions,
    clientOptions
  );

  client.start();

  context.subscriptions.push({
    dispose: () => {
      client.stop();
    },
  });
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

import * as vscode from 'vscode';
import { WebDevViewProvider } from './webview/WebviewProvider';
import { KeyManager } from './core/KeyManager';
import { WebDevPanel } from './WebDevPanel';

export function activate(context: vscode.ExtensionContext) {
  const keyManager = new KeyManager(context.globalState);
  const provider = new WebDevViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      WebDevViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // When sidebar becomes visible, close the panel (avoids two instances fighting)
  // and refresh sidebar with the latest history saved by the panel
  provider.onVisible = () => {
    WebDevPanel.currentPanel?.dispose();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('webdev.open', () => {
      vscode.commands.executeCommand('workbench.view.extension.webdev');
    }),
    vscode.commands.registerCommand('webdev.newSession', () => {
      provider.newSession();
    }),
    vscode.commands.registerCommand('webdev.configure', async () => {
      await WebDevViewProvider.configureProvider(keyManager);
    }),
    vscode.commands.registerCommand('webdev.openPanel', () => {
      // onDispose: when panel closes, push its history to the sidebar
      WebDevPanel.createOrShow(context, () => provider.sendHistory());
    })
  );
}

export function deactivate() {}

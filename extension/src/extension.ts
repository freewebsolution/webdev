import * as vscode from 'vscode';
import { WebDevViewProvider } from './webview/WebviewProvider';
import { KeyManager } from './core/KeyManager';
import { WebDevPanel } from './WebDevPanel';

const GITHUB_REPO = 'freewebsolution/webdev';
const CURRENT_VERSION: string = require('../package.json').version;

async function checkForUpdate(context: vscode.ExtensionContext, force = false): Promise<void> {
  const lastCheck = context.globalState.get<number>('webdev.lastUpdateCheck', 0);
  if (!force && Date.now() - lastCheck < 86_400_000) { return; }

  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
      headers: { 'User-Agent': 'vscode-webdev-ai' }
    });
    if (!res.ok) {
      if (force) { vscode.window.showWarningMessage(`WebDev AI: GitHub API risposto ${res.status}`); }
      return;
    }
    const data = await res.json() as { tag_name: string; html_url: string };
    const latest = data.tag_name?.replace(/^v/, '');
    if (!latest) { return; }

    await context.globalState.update('webdev.lastUpdateCheck', Date.now());

    if (latest !== CURRENT_VERSION) {
      const action = await vscode.window.showInformationMessage(
        `WebDev AI: disponibile la versione ${latest} (installata: ${CURRENT_VERSION})`,
        'Scarica aggiornamento',
        'Ignora'
      );
      if (action === 'Scarica aggiornamento') {
        vscode.env.openExternal(vscode.Uri.parse(data.html_url));
      }
    } else if (force) {
      vscode.window.showInformationMessage(`WebDev AI: sei già all'ultima versione (${CURRENT_VERSION})`);
    }
  } catch (e) {
    if (force) { vscode.window.showWarningMessage(`WebDev AI: controllo aggiornamenti fallito — ${e}`); }
  }
}

export function activate(context: vscode.ExtensionContext) {
  const keyManager = new KeyManager(context.globalState);
  const provider = new WebDevViewProvider(context);

  // Reset so check always runs on first activation after install
  context.globalState.update('webdev.lastUpdateCheck', 0);
  checkForUpdate(context);

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
    }),
    vscode.commands.registerCommand('webdev.checkUpdate', () => {
      checkForUpdate(context, true);
    })
  );
}

export function deactivate() {}

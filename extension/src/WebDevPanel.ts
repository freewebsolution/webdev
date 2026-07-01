import * as vscode from 'vscode';
import { WebDevViewProvider } from './webview/WebviewProvider';
import { KeyManager } from './core/KeyManager';
import { SessionManager, STACK_OPTIONS } from './core/SessionManager';
import { ContextBuilder } from './core/ContextBuilder';
import { GroqProvider } from './providers/GroqProvider';
import { DocumentExtractor } from './core/DocumentExtractor';

const MODEL_HISTORY_LIMITS: Record<string, number> = {
  'qwen/qwen3-32b': 3000,
};
const DEFAULT_HISTORY_CHARS = 120000;
const KEEP_RECENT = 6;

type Msg = { role: 'user' | 'assistant' | 'system'; content: string; image?: { base64: string; mimeType: string } };

async function compactHistory(messages: Msg[], model: string, apiKey: string): Promise<{ messages: Msg[]; compacted: boolean }> {
  const limit = MODEL_HISTORY_LIMITS[model] ?? DEFAULT_HISTORY_CHARS;
  const total = messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  if (total <= limit || messages.length <= KEEP_RECENT) {
    return { messages, compacted: false };
  }

  const toSummarize = messages.slice(0, messages.length - KEEP_RECENT);
  const recent = messages.slice(messages.length - KEEP_RECENT);

  const conversationText = toSummarize
    .map(m => `${m.role === 'user' ? 'Utente' : 'AI'}: ${m.content.slice(0, 800)}`)
    .join('\n\n');

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [{
          role: 'user',
          content: `Riassumi questa conversazione in modo conciso (max 400 parole), preservando tutti i dettagli tecnici, decisioni e contesto rilevante:\n\n${conversationText}`
        }],
        max_tokens: 600,
        stream: false
      })
    });

    if (res.ok) {
      const data = await res.json() as { choices: { message: { content: string } }[] };
      const summary = data.choices?.[0]?.message?.content ?? '';
      if (summary) {
        const summaryMsg: Msg = {
          role: 'user',
          content: `[Riepilogo conversazione precedente]\n${summary}\n[Fine riepilogo — continua da qui]`
        };
        return { messages: [summaryMsg, ...recent], compacted: true };
      }
    }
  } catch {
    // fall through to simple trim on error
  }

  // Fallback: trim if summarization fails
  const trimmed = [...messages];
  let tot = total;
  while (trimmed.length > 1 && tot > limit) {
    const removed = trimmed.shift();
    tot -= removed?.content?.length ?? 0;
  }
  return { messages: trimmed, compacted: false };
}

export class WebDevPanel {
  public static currentPanel: WebDevPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private keyManager: KeyManager;
  private session: SessionManager;
  private abortController?: AbortController;
  private readonly disposables: vscode.Disposable[] = [];
  private lastActiveEditor?: vscode.TextEditor;

  public static createOrShow(context: vscode.ExtensionContext, onDispose?: () => void): void {
    const column = vscode.ViewColumn.Beside;
    if (WebDevPanel.currentPanel) {
      WebDevPanel.currentPanel.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'webdev.panel',
      'WebDev AI',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      }
    );
    WebDevPanel.currentPanel = new WebDevPanel(panel, context, onDispose);
  }

  private constructor(panel: vscode.WebviewPanel, private readonly context: vscode.ExtensionContext, private readonly onDispose?: () => void) {
    this.panel = panel;
    this.keyManager = new KeyManager(context.globalState);
    const savedPrompt = context.globalState.get<string>('webdev.systemPrompt');
    this.session = new SessionManager(savedPrompt);

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'assets', 'icon-dark.svg'),
    };
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
    this.panel.webview.html = WebDevViewProvider.buildHtml(this.panel.webview, context.extensionUri);

    // Track last focused text editor — activeTextEditor is undefined when panel is focused
    if (vscode.window.activeTextEditor) {
      this.lastActiveEditor = vscode.window.activeTextEditor;
    }
    vscode.window.onDidChangeActiveTextEditor(e => {
      if (e) { this.lastActiveEditor = e; }
    }, null, this.disposables);

    this.panel.webview.onDidReceiveMessage(async (msg) => {
      try {
        switch (msg.type) {
          case 'getStatus': this.sendStatus(); break;
          case 'openSettings': await this.handleOpenSettings(); break;
          case 'configureTriage': await this.handleConfigureTriage(); break;
          case 'importFile': await this.handleImportFile(); break;
          case 'importSelection': await this.handleImportSelection(); break;
          case 'importDoc': await this.handleImportDoc(); break;
          case 'extractDoc': await this.handleExtractDoc(msg.name, msg.data); break;
          case 'chat': await this.handleChat(msg.messages, msg.model, msg.provider); break;
          case 'cancel':
            this.abortController?.abort();
            this.panel.webview.postMessage({ type: 'done' });
            break;
          case 'newSession': this.newSession(); break;
          case 'saveHistory':
            await this.context.globalState.update('webdev.chatHistory', msg.messages);
            break;
        }
      } catch (e: unknown) {
        const err = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`WebDev AI errore: ${err}`);
      }
    }, null, this.disposables);

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    setTimeout(() => {
      this.sendStatus();
      this.sendTriageInfo();
      this.sendHistory();
    }, 150);
  }

  private sendHistory(): void {
    const history = this.context.globalState.get<unknown[]>('webdev.chatHistory', []);
    if (history.length > 0) {
      this.panel.webview.postMessage({ type: 'restoreHistory', messages: history });
    }
  }

  private newSession(): void {
    this.session.clear();
    this.panel.webview.postMessage({ type: 'clearChat' });
  }

  private sendStatus(): void {
    this.panel.webview.postMessage({ type: 'status', providers: this.keyManager.getStatus() });
  }

  private sendTriageInfo(): void {
    const stack = this.session.getActiveStack();
    const stackLabel = STACK_OPTIONS.find(s => s.id === stack)?.description ?? 'Custom';
    this.panel.webview.postMessage({ type: 'triageInfo', stack, stackLabel });
  }

  private async handleOpenSettings(): Promise<void> {
    await WebDevViewProvider.configureProvider(this.keyManager, () => this.sendStatus());
  }

  private async handleConfigureTriage(): Promise<void> {
    const current = this.session.getActiveStack();
    const items = STACK_OPTIONS.map(s => ({ ...s, picked: s.id === current }));

    const pick = await vscode.window.showQuickPick(items, {
      title: 'WebDev AI — Configura Triage',
      placeHolder: 'Seleziona lo stack tecnologico principale',
    });
    if (!pick) return;

    if (pick.id === 'custom') {
      const currentPrompt = this.session.getSystemPrompt();
      const text = await vscode.window.showInputBox({
        title: 'WebDev AI — System Prompt',
        prompt: 'Scrivi il prompt di sistema personalizzato',
        value: currentPrompt,
        ignoreFocusOut: true,
      });
      if (!text) return;
      this.session.setStack('custom', text);
      await this.context.globalState.update('webdev.systemPrompt', text);
    } else {
      this.session.setStack(pick.id);
      await this.context.globalState.update('webdev.systemPrompt', this.session.getSystemPrompt());
    }

    this.sendTriageInfo();
    vscode.window.showInformationMessage(`WebDev AI: stack impostato → ${pick.description}`);
  }

  private async handleImportFile(): Promise<void> {
    const editor = this.lastActiveEditor ?? vscode.window.activeTextEditor;
    if (!editor) {
      this.panel.webview.postMessage({ type: 'toast', message: 'Nessun file attivo' });
      return;
    }
    const doc = editor.document;
    this.panel.webview.postMessage({
      type: 'fileImported',
      name: doc.fileName.split('/').pop(),
      content: doc.getText(),
      language: doc.languageId
    });
  }

  private async handleImportSelection(): Promise<void> {
    const editor = this.lastActiveEditor ?? vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.panel.webview.postMessage({ type: 'toast', message: 'Nessuna selezione attiva' });
      return;
    }
    const doc = editor.document;
    this.panel.webview.postMessage({
      type: 'fileImported',
      name: `selezione (${doc.languageId})`,
      content: doc.getText(editor.selection),
      language: doc.languageId
    });
  }

  private async handleImportDoc(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: {
        'Documenti': ['docx', 'pdf', 'xml'],
        'Tutti i file': ['*']
      },
      title: 'Importa documento'
    });
    if (!uris || uris.length === 0) return;

    try {
      const { text, name } = DocumentExtractor.extract(uris[0].fsPath);
      this.panel.webview.postMessage({ type: 'docImported', name, content: text });
    } catch (e: unknown) {
      this.panel.webview.postMessage({ type: 'toast', message: `Errore: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private async handleExtractDoc(name: string, base64data: string): Promise<void> {
    try {
      const buffer = Buffer.from(base64data, 'base64');
      const { text } = DocumentExtractor.extractBuffer(buffer, name);
      this.panel.webview.postMessage({ type: 'docImported', name, content: text });
    } catch (e: unknown) {
      this.panel.webview.postMessage({ type: 'toast', message: `Errore estrazione: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private async handleChat(
    messages: { role: 'user' | 'assistant'; content: string; image?: { base64: string; mimeType: string } }[],
    model: string,
    provider: string
  ): Promise<void> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const callbacks = {
      onChunk: (text: string) => {
        this.panel.webview.postMessage({ type: 'chunk', text });
      },
      onEnd: async () => {
        this.panel.webview.postMessage({ type: 'done' });
      },
      onError: (message: string) => {
        this.panel.webview.postMessage({ type: 'error', message });
      },
      signal
    };

    try {
      switch (provider) {
        case 'groq': {
          const key = this.keyManager.get('groq');
          if (!key) { callbacks.onError('Configura la API key Groq: clicca ⚙ impostazioni'); return; }
          const gp = new GroqProvider(key);
          const systemMsg = { role: 'system' as const, content: this.session.getSystemPrompt() };
          const { messages: compacted, compacted: wasCompacted } = await compactHistory(messages as Msg[], model, key);
          if (wasCompacted) {
            this.panel.webview.postMessage({ type: 'toast', message: '📝 Cronologia compattata automaticamente' });
          }
          await gp.chat([systemMsg, ...compacted], model, callbacks);
          break;
        }
        default:
          callbacks.onError(`Provider non supportato: ${provider}`);
      }
    } catch (e: unknown) {
      const err = e as Error;
      if (err.name !== 'AbortError') {
        callbacks.onError(err.message);
      }
    }
  }

  public dispose(): void {
    WebDevPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) d.dispose();
    this.onDispose?.();
  }
}

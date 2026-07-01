import * as vscode from 'vscode';
import { KeyManager } from '../core/KeyManager';
import { SessionManager } from '../core/SessionManager';
import { ContextBuilder } from '../core/ContextBuilder';
import { GroqProvider } from '../providers/GroqProvider';
import { STACK_OPTIONS } from '../core/SessionManager';
import { DocumentExtractor } from '../core/DocumentExtractor';

const MODEL_HISTORY_LIMITS: Record<string, number> = {
  'qwen/qwen3-32b': 3000,
};
const DEFAULT_HISTORY_CHARS = 120000;
const KEEP_RECENT = 6; // always keep last 3 exchanges (6 messages)

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

export class WebDevViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'webdev.sidebar';

  public onVisible?: () => void;

  private view?: vscode.WebviewView;
  private keyManager: KeyManager;
  private session: SessionManager;
  private abortController?: AbortController;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.keyManager = new KeyManager(context.globalState);
    const savedPrompt = context.globalState.get<string>('webdev.systemPrompt');
    this.session = new SessionManager(savedPrompt);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.context.extensionUri,
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    webviewView.webview.html = WebDevViewProvider.buildHtml(webviewView.webview, this.context.extensionUri);

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this.onVisible?.();
        this.sendHistory();
      }
    });

    webviewView.webview.onDidReceiveMessage(async (msg) => {
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
            this.view?.webview.postMessage({ type: 'done' });
            break;
          case 'newSession': this.newSession(); break;
          case 'saveHistory':
            await this.context.globalState.update('webdev.chatHistory', msg.messages);
            break;
          case 'ready': break;
        }
      } catch (e: unknown) {
        const err = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`WebDev AI errore: ${err}`);
      }
    });

    setTimeout(() => {
      this.sendStatus();
      this.sendTriageInfo();
      this.sendHistory();
    }, 100);
  }

  public sendHistory(): void {
    const history = this.context.globalState.get<unknown[]>('webdev.chatHistory', []);
    if (history.length > 0) {
      this.view?.webview.postMessage({ type: 'restoreHistory', messages: history });
    }
  }

  newSession(): void {
    this.session.clear();
    this.view?.webview.postMessage({ type: 'clearChat' });
  }

  private sendStatus(): void {
    const status = this.keyManager.getStatus();
    this.view?.webview.postMessage({ type: 'status', providers: status });
  }

  static async configureProvider(keyManager: KeyManager, sendStatus?: () => void): Promise<void> {
    const PROVIDERS = [
      { label: '$(key) Groq — LLaMA / Mixtral (gratuito)', id: 'groq', url: 'https://console.groq.com/keys', placeholder: 'gsk_...' },
      { label: '$(trash) Rimuovi chiave Groq', id: '_delete', url: '', placeholder: '' },
    ];

    const pick = await vscode.window.showQuickPick(PROVIDERS, {
      placeHolder: 'Configura API key Groq',
      title: 'WebDev AI — Impostazioni'
    });
    if (!pick) return;

    if (pick.id === '_delete') {
      await keyManager.delete('groq');
      if (sendStatus) sendStatus();
      vscode.window.showInformationMessage('Chiave Groq rimossa');
      return;
    }

    await vscode.env.openExternal(vscode.Uri.parse(pick.url));

    const key = await vscode.window.showInputBox({
      title: 'WebDev AI — Groq API Key',
      prompt: 'Crea una chiave su console.groq.com e incollala qui',
      placeHolder: pick.placeholder,
      password: true,
      ignoreFocusOut: true,
      validateInput: v => (!v || !v.trim() ? 'Incolla la API key' : undefined)
    });
    if (!key) return;

    await keyManager.save('groq', key.trim());
    if (sendStatus) sendStatus();
    vscode.window.showInformationMessage('✓ Groq configurato correttamente');
  }

  private async handleOpenSettings(): Promise<void> {
    await WebDevViewProvider.configureProvider(this.keyManager, () => this.sendStatus());
  }

  private sendTriageInfo(): void {
    const stack = this.session.getActiveStack();
    const stackLabel = STACK_OPTIONS.find(s => s.id === stack)?.description ?? 'Custom';
    this.view?.webview.postMessage({ type: 'triageInfo', stack, stackLabel });
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
      const current = this.session.getSystemPrompt();
      const text = await vscode.window.showInputBox({
        title: 'WebDev AI — System Prompt',
        prompt: 'Scrivi il prompt di sistema personalizzato',
        value: current,
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
    const ctx = await ContextBuilder.getActiveFileContext();
    if (!ctx) {
      this.view?.webview.postMessage({ type: 'toast', message: 'Nessun file attivo' });
      return;
    }
    this.view?.webview.postMessage({
      type: 'fileImported',
      name: ctx.fileName.split('/').pop(),
      content: ctx.content,
      language: ctx.language
    });
  }

  private async handleImportSelection(): Promise<void> {
    const ctx = await ContextBuilder.getSelectionContext();
    if (!ctx) {
      this.view?.webview.postMessage({ type: 'toast', message: 'Nessuna selezione attiva' });
      return;
    }
    this.view?.webview.postMessage({
      type: 'fileImported',
      name: `selezione (${ctx.language})`,
      content: ctx.content,
      language: ctx.language
    });
  }

  private async handleExtractDoc(name: string, base64data: string): Promise<void> {
    try {
      const buffer = Buffer.from(base64data, 'base64');
      const { text } = DocumentExtractor.extractBuffer(buffer, name);
      this.view?.webview.postMessage({ type: 'docImported', name, content: text });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.view?.webview.postMessage({ type: 'toast', message: `Errore estrazione: ${msg}` });
    }
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
      this.view?.webview.postMessage({ type: 'docImported', name, content: text });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.view?.webview.postMessage({ type: 'toast', message: `Errore: ${msg}` });
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
        this.view?.webview.postMessage({ type: 'chunk', text });
      },
      onEnd: async () => {
        this.view?.webview.postMessage({ type: 'done' });
      },
      onError: (message: string) => {
        this.view?.webview.postMessage({ type: 'error', message });
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
            this.view?.webview.postMessage({ type: 'toast', message: '📝 Cronologia compattata automaticamente' });
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

  public static buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'webview.js')
    );
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src ${webview.cspSource}; img-src ${webview.cspSource} data:;`;
    return `<!DOCTYPE html>
<html lang="it">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta http-equiv="Content-Security-Policy" content="${csp}"/>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{
  position:relative;
  font-family:var(--vscode-font-family);
  font-size:var(--vscode-font-size,13px);
  color:var(--vscode-foreground);
  background:var(--vscode-sideBar-background,var(--vscode-editor-background));
  display:flex;flex-direction:column;height:100vh;
}
.header{
  display:flex;align-items:center;gap:6px;
  padding:8px 10px 6px;
  border-bottom:1px solid var(--vscode-editorWidget-border,#333);
  flex-shrink:0;
}
.header-title{
  font-weight:600;font-size:12px;letter-spacing:.5px;
  color:var(--vscode-foreground);flex:1;
}
.provider-pills{display:flex;gap:3px;align-items:center}
.pill{
  display:inline-flex;align-items:center;gap:3px;
  font-size:10px;padding:2px 6px;border-radius:10px;
  background:var(--vscode-badge-background,#2a2a2a);
  color:var(--vscode-descriptionForeground,#888);
  border:1px solid transparent;cursor:default;
  white-space:nowrap;
}
.pill.active{
  border-color:var(--vscode-textLink-foreground,#4fc);
  color:var(--vscode-textLink-foreground,#4fc);
  background:rgba(79,252,176,.08);
}
.pill.selected{
  background:var(--vscode-button-background,#0e639c);
  color:var(--vscode-button-foreground,#fff);
  border-color:var(--vscode-button-background,#0e639c);
  font-weight:600;
}
.pill-dot{width:5px;height:5px;border-radius:50%;background:currentColor;flex-shrink:0}
.stack-bar{
  padding:3px 10px;font-size:10px;
  color:var(--vscode-descriptionForeground,#888);
  border-bottom:1px solid var(--vscode-editorWidget-border,#333);
  flex-shrink:0;display:flex;align-items:center;gap:5px;
  cursor:pointer;
}
.stack-bar:hover{background:var(--vscode-list-hoverBackground)}
.stack-label{flex:1;}
.icon-btn{
  background:none;border:none;cursor:pointer;
  color:var(--vscode-icon-foreground,var(--vscode-foreground));
  opacity:.7;padding:3px;border-radius:3px;
  display:flex;align-items:center;justify-content:center;
  transition:opacity .15s;
}
.icon-btn:hover{opacity:1;background:var(--vscode-list-hoverBackground)}
.icon-btn.auto-on{
  opacity:1;
  background:rgba(79,252,176,.12);
  border-color:var(--vscode-textLink-foreground,#4fc) !important;
  color:var(--vscode-textLink-foreground,#4fc);
}
.model-bar{
  padding:5px 10px;
  border-bottom:1px solid var(--vscode-editorWidget-border,#333);
  flex-shrink:0;
}
select{
  width:100%;
  background:var(--vscode-input-background);
  color:var(--vscode-input-foreground);
  border:1px solid var(--vscode-input-border,transparent);
  border-radius:4px;padding:4px 6px;font-size:12px;
  cursor:pointer;outline:none;
}
select:focus{border-color:var(--vscode-focusBorder,#4fc)}
.chat{
  flex:1;overflow-y:auto;
  padding:12px 10px;
  display:flex;flex-direction:column;gap:12px;
  scrollbar-width:thin;
  scrollbar-color:var(--vscode-scrollbarSlider-background,#444) transparent;
}
.chat::-webkit-scrollbar{width:4px}
.chat::-webkit-scrollbar-thumb{background:var(--vscode-scrollbarSlider-background,#444);border-radius:2px}
.msg{display:flex;flex-direction:column;gap:3px;max-width:100%}
.msg.user{align-items:flex-end}
.msg.assistant{align-items:flex-start}
.bubble{
  padding:8px 11px;border-radius:8px;
  max-width:90%;word-break:break-word;
  font-size:13px;line-height:1.5;
}
.msg.user .bubble{
  background:var(--vscode-button-background,#0e639c);
  color:var(--vscode-button-foreground,#fff);
  border-radius:8px 8px 2px 8px;
}
.msg.assistant .bubble{
  background:var(--vscode-input-background,#252526);
  color:var(--vscode-foreground);
  border-radius:8px 8px 8px 2px;
  border:1px solid var(--vscode-editorWidget-border,#333);
}
.msg-meta{font-size:10px;color:var(--vscode-descriptionForeground,#888);padding:0 4px}
.typing-dots{display:inline-flex;gap:4px;align-items:center;padding:4px 0}
.typing-dots span{
  width:6px;height:6px;border-radius:50%;
  background:var(--vscode-textLink-foreground,#4fc);
  animation:bounce .9s infinite;
}
.typing-dots span:nth-child(2){animation-delay:.15s}
.typing-dots span:nth-child(3){animation-delay:.3s}
@keyframes bounce{0%,80%,100%{transform:translateY(0)}40%{transform:translateY(-5px)}}
.bubble code{
  background:var(--vscode-textCodeBlock-background,rgba(0,0,0,.3));
  border-radius:3px;padding:1px 4px;font-family:var(--vscode-editor-font-family,monospace);
  font-size:.9em;
}
.code-block{margin:6px 0;border-radius:5px;overflow:hidden;border:1px solid var(--vscode-editorWidget-border,#444)}
.code-header{
  display:flex;align-items:center;justify-content:space-between;
  background:rgba(0,0,0,.25);
  padding:3px 10px;
  font-size:10px;color:var(--vscode-descriptionForeground,#888);
  font-family:var(--vscode-editor-font-family,monospace);
  user-select:none;
}
.copy-btn{
  background:none;
  border:1px solid var(--vscode-editorWidget-border,#555);
  color:var(--vscode-descriptionForeground,#888);
  border-radius:3px;padding:1px 8px;font-size:10px;cursor:pointer;
  transition:all .15s;white-space:nowrap;
}
.copy-btn:hover{background:var(--vscode-list-hoverBackground);color:var(--vscode-foreground)}
.copy-btn.copied{color:var(--vscode-textLink-foreground,#4fc);border-color:var(--vscode-textLink-foreground,#4fc)}
.bubble pre{
  background:var(--vscode-textCodeBlock-background,rgba(0,0,0,.3));
  border-radius:0;padding:10px;overflow-x:auto;margin:0;
  font-family:var(--vscode-editor-font-family,monospace);font-size:.88em;
}
.bubble pre code{background:none;padding:0}
.bubble h1,.bubble h2,.bubble h3{margin:8px 0 4px;font-weight:600}
.bubble h1{font-size:1.1em}
.bubble h2{font-size:1.05em}
.bubble h3{font-size:1em}
.bubble ul,.bubble ol{padding-left:18px;margin:4px 0}
.bubble li{margin:2px 0}
.bubble strong{font-weight:600}
.bubble em{font-style:italic}
.bubble hr{border:none;border-top:1px solid var(--vscode-editorWidget-border,#444);margin:8px 0}
.bubble p{margin:4px 0}
.bubble p:first-child{margin-top:0}
.bubble p:last-child{margin-bottom:0}
.welcome{
  text-align:center;padding:24px 16px;
  color:var(--vscode-descriptionForeground,#888);
}
.welcome h3{font-size:14px;margin-bottom:8px;color:var(--vscode-foreground)}
.welcome p{font-size:12px;line-height:1.5}
.input-area{
  padding:8px 10px 10px;
  flex-shrink:0;
  position:relative;
}
.input-card{
  background:var(--vscode-input-background);
  border:1px solid var(--vscode-input-border,var(--vscode-editorWidget-border,#555));
  border-radius:10px;
  position:relative;
}
.input-card:focus-within{
  border-color:var(--vscode-focusBorder,#4fc);
}
.file-chips{
  display:none;flex-wrap:wrap;gap:5px;
  padding:8px 10px 4px;
}
.file-chip{
  display:inline-flex;align-items:center;gap:4px;
  background:var(--vscode-badge-background,#2a2d2e);
  border:1px solid var(--vscode-editorWidget-border,#444);
  border-radius:6px;padding:3px 7px;font-size:11px;
  color:var(--vscode-foreground);max-width:200px;
}
.chip-name{
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:90px;
}
.chip-dims{opacity:.55;flex-shrink:0;font-size:10px}
.chip-remove{
  background:none;border:none;cursor:pointer;
  color:var(--vscode-descriptionForeground,#888);
  padding:0 0 0 3px;font-size:10px;line-height:1;opacity:.7;
  flex-shrink:0;
}
.chip-remove:hover{opacity:1;color:#ef4444}
textarea#prompt{
  width:100%;background:transparent;border:none;
  color:var(--vscode-input-foreground);
  padding:10px 12px 6px 12px;
  font-family:var(--vscode-font-family);font-size:13px;
  resize:none;outline:none;
  min-height:38px;max-height:200px;
  line-height:1.4;overflow-y:auto;display:block;
}
.input-card-footer{
  display:flex;align-items:center;
  padding:4px 8px 8px;gap:6px;
  border-top:1px solid var(--vscode-editorWidget-border,#333);
  margin-top:4px;
}
.footer-left{display:flex;gap:4px;align-items:center}
.footer-right{display:flex;gap:6px;align-items:center;margin-left:auto}
.footer-divider{width:1px;height:18px;background:var(--vscode-editorWidget-border,#444);flex-shrink:0}
.auto-pill{
  display:flex;align-items:center;gap:4px;
  background:none;border:1px solid var(--vscode-editorWidget-border,#444);
  color:var(--vscode-descriptionForeground,#888);
  font-family:var(--vscode-font-family);font-size:11px;
  padding:2px 8px;border-radius:10px;cursor:pointer;
  transition:all .15s;white-space:nowrap;
}
.auto-pill:hover{border-color:var(--vscode-foreground);color:var(--vscode-foreground)}
.auto-pill.on{
  border-color:var(--vscode-textLink-foreground,#4fc);
  color:var(--vscode-textLink-foreground,#4fc);
  background:rgba(79,252,176,.08);
}
.slash-btn{
  background:none;border:1px solid var(--vscode-editorWidget-border,#444);
  color:var(--vscode-descriptionForeground,#888);
  width:24px;height:24px;border-radius:5px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  font-size:12px;font-weight:600;transition:all .15s;flex-shrink:0;
}
.slash-btn:hover{color:var(--vscode-foreground);border-color:var(--vscode-foreground)}
#sendBtn{
  background:var(--vscode-button-background,#0e639c);
  color:var(--vscode-button-foreground,#fff);
  border:none;width:30px;height:30px;border-radius:8px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
  flex-shrink:0;transition:background .15s;
}
#sendBtn:hover{background:var(--vscode-button-hoverBackground,#1177bb)}
#sendBtn.stopping{background:#c0392b}
.toast{
  position:fixed;bottom:60px;left:50%;transform:translateX(-50%);
  background:var(--vscode-badge-background,#333);
  color:var(--vscode-badge-foreground,#fff);
  padding:5px 14px;border-radius:12px;font-size:11px;
  z-index:20;opacity:0;transition:opacity .2s;pointer-events:none;
  white-space:nowrap;
}
.toast.show{opacity:1}
.attach-btn{
  background:none;
  border:1px solid var(--vscode-editorWidget-border,#444);
  color:var(--vscode-foreground);
  width:28px;height:28px;border-radius:50%;
  font-size:18px;line-height:1;cursor:pointer;flex-shrink:0;
  display:flex;align-items:center;justify-content:center;
  transition:background .15s;
}
.attach-btn:hover{background:var(--vscode-list-hoverBackground)}
.attach-menu{
  display:none;position:absolute;
  bottom:calc(100% + 6px);left:10px;
  background:var(--vscode-editorWidget-background,var(--vscode-editor-background,#1e1e1e));
  border:1px solid var(--vscode-editorWidget-border,#444);
  border-radius:6px;overflow:hidden;z-index:50;min-width:180px;
  box-shadow:0 4px 16px rgba(0,0,0,.4);
}
.attach-menu.open{display:block}
.attach-item{
  display:flex;align-items:center;gap:9px;
  width:100%;padding:9px 13px;
  background:none;border:none;cursor:pointer;
  color:var(--vscode-foreground);font-family:var(--vscode-font-family);
  font-size:12px;text-align:left;transition:background .1s;white-space:nowrap;
}
.attach-item:hover{background:var(--vscode-list-hoverBackground)}
.attach-item svg{flex-shrink:0;opacity:.75}
.attach-divider{height:1px;background:var(--vscode-editorWidget-border,#333);margin:3px 0}
#dropOverlay{
  display:none;position:fixed;inset:0;z-index:200;
  background:rgba(0,120,212,.12);
  border:2px dashed var(--vscode-textLink-foreground,#4fc);
  border-radius:6px;
  flex-direction:column;align-items:center;justify-content:center;gap:10px;
  pointer-events:none;
}
#dropOverlay.visible{display:flex}
.drop-overlay-icon{font-size:32px;line-height:1}
.drop-overlay-title{font-size:14px;font-weight:600;color:var(--vscode-textLink-foreground,#4fc)}
.drop-overlay-sub{font-size:11px;color:var(--vscode-descriptionForeground,#888)}
</style>
</head>
<body>

<div class="header">
  <span class="header-title">WebDev AI</span>
  <button class="icon-btn" id="newChatBtn" title="Nuova sessione">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 2h10v1H2v9H1V2zm2 2h10v1H4v8H3V4zm2 2h9v9H5V6zm1 1v7h7V7H6z"/>
    </svg>
  </button>
  <button class="icon-btn" id="settingsBtn" title="Impostazioni (API key Groq)">
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M9.1 4.4L8.6 2H7.4l-.5 2.4-.7.3-2-1.3-.9.8 1.3 2-.2.7-2.4.5v1.2l2.4.5.3.8-1.3 2 .8.8 2-1.3.8.3.4 2.3h1.2l.5-2.4.8-.3 2 1.3.8-.8-1.3-2 .3-.8 2.3-.4V7.4l-2.4-.5-.3-.8 1.3-2-.8-.8-2 1.3-.7-.2zM8 9.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"/>
    </svg>
  </button>
</div>

<div class="model-bar">
  <select id="modelSelect" style="width:100%"></select>
</div>

<div class="stack-bar" id="stackBar" title="Clicca per cambiare stack / system prompt">
  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" opacity=".7"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm1 10H7V7h2v4zm0-6H7V3h2v2z"/></svg>
  <span class="stack-label" id="stackLabel">Caricamento...</span>
  <span style="opacity:.5;font-size:9px">▾ configura</span>
</div>

<div class="chat" id="chat">
  <div class="welcome" id="welcome">
    <h3>WebDev AI — Groq</h3>
    <p>LLaMA, Mixtral, Gemma — modelli gratuiti via Groq.<br>
    Incolla errori, log, stack trace o descrizioni bug.<br>
    Importa file e selezioni dall'editor.</p>
  </div>
</div>

<div class="input-area">
  <div class="attach-menu" id="attachMenu">
    <button class="attach-item" id="menuFilePickerBtn">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 3H9.707L8.854 2.146A.5.5 0 0 0 8.5 2h-5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h10a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 13.5 3zM3 3.5A.5.5 0 0 1 3.5 3H8.3l.853.854.147.146H13.5a.5.5 0 0 1 .5.5V5H2v-.5A.5.5 0 0 1 2.5 4H3v-.5zm11 9a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5V6h11v6.5z"/></svg>
      Carica file
    </button>
    <div class="attach-divider"></div>
    <button class="attach-item" id="menuActiveFileBtn">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M9 1.5V5h3.5L9 1.5zM3 1h5.5l4 4V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm5 4V2H3v12h8V5H8z"/></svg>
      File attivo
    </button>
    <button class="attach-item" id="menuSelectionBtn">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h2v1H3v8h1v1H2V3zm10 0h2v10h-2v-1h1V4h-1V3zM5 7h6v2H5V7z"/></svg>
      Selezione
    </button>
  </div>
  <div class="input-card">
    <div class="file-chips" id="fileChips"></div>
    <textarea id="prompt" placeholder="Chiedi qualcosa… (Ctrl+V per screenshot)" rows="1"></textarea>
    <div class="input-card-footer">
      <div class="footer-left">
        <button class="attach-btn" id="attachBtn" title="Allega">+</button>
        <button class="slash-btn" id="slashBtn" title="Comandi">/</button>
      </div>
      <div class="footer-right">
        <button class="auto-pill" id="autoTriageBtn" title="Auto Triage">&#x26A1; Auto</button>
        <button id="sendBtn" title="Invia (Enter)">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1.5L3.5 7H6.5v7h3V7H12.5L8 1.5z"/>
          </svg>
        </button>
      </div>
    </div>
  </div>
  <input type="file" id="fileInput" multiple style="display:none"
         accept="image/*,.pdf,.docx,.xml,.txt,.js,.ts,.jsx,.tsx,.json,.md,.css,.html,.py,.php,.sql,.csv,.log">
</div>

<div class="toast" id="toast"></div>

<div id="dropOverlay">
  <div class="drop-overlay-icon">&#x1F4C2;</div>
  <div class="drop-overlay-title">Rilascia qui</div>
  <div class="drop-overlay-sub">Immagini &middot; PDF &middot; DOCX &middot; XML &middot; Testo</div>
</div>

<script src="${scriptUri}"></script>
</body>
</html>`;
  }
}

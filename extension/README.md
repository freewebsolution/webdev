# WebDev AI

Assistente AI per sviluppatori web integrato direttamente in VS Code. Powered by **Groq** — modelli LLaMA, Qwen e GPT OSS completamente **gratuiti**.

---

## Prima di iniziare — Configura la chiave API Groq

> **Groq è gratuito.** Basta registrarsi su console.groq.com per ottenere la chiave.

1. Vai su **[console.groq.com/keys](https://console.groq.com/keys)** e crea un account gratuito
2. Clicca **"Create API Key"** e copia la chiave generata (`gsk_...`)
3. Apri **WebDev AI** dalla Activity Bar (icona nella barra laterale sinistra)
4. Clicca l'icona **⚙** in alto a destra nell'interfaccia
5. Incolla la chiave Groq nella finestra che si apre
6. Sei pronto — inizia a chattare

---

## Funzionalità

- **Chat streaming** con LLaMA 3.3 70B, GPT OSS 120B, Qwen3 32B, Llama 4 Vision e altri
- **Auto Triage** — seleziona automaticamente il modello più adatto al tipo di richiesta
- **Import file attivo** — importa con un click il file aperto nell'editor
- **Import selezione** — importa solo il testo selezionato nell'editor
- **Allegati multipli** — drag & drop o selezione di immagini, PDF, DOCX, XML, sorgenti
- **Vision** — analisi screenshot e mockup con Llama 4 Scout / Maverick
- **Compattazione automatica** della cronologia per conversazioni molto lunghe
- **Sessione persistente** — la chat sopravvive al riavvio di VS Code
- **Doppia modalità**: sidebar nell'Activity Bar oppure tab editor pieno (stile Claude Code)
- **Stack preconfigurati**: Laravel/PHP, React/TypeScript, Full Stack, Node.js, WordPress

---

## Come iniziare

1. Installa l'estensione
2. Clicca l'icona **WebDev AI** nella Activity Bar (barra sinistra di VS Code)
3. Clicca **⚙** e inserisci la tua API key Groq gratuita
4. Incolla errori, log, stack trace, descrizioni bug o codice
5. Premi **Invio** — la risposta arriva in streaming

**Per aprire in tab editor pieno**: `Ctrl+Shift+P` → `WebDev AI: Apri Editor`

---

## Modelli disponibili (tutti gratuiti via Groq)

| Modello | Velocità | Uso ideale |
|---|---|---|
| LLaMA 3.3 70B | ★★★★ | Migliore qualità generale |
| GPT OSS 120B | ★★★★ | Code review, architettura |
| GPT OSS 20B | ★★★★★ | Risposte veloci, debug rapido |
| LLaMA 3.1 8B | ★★★★★ | Ultra veloce |
| Qwen3 32B | ★★★ | Ragionamento, matematica, logica |
| Llama 4 Scout | ★★★ | Analisi immagini e screenshot |
| Llama 4 Maverick | ★★★ | Analisi immagini alta qualità |
| Compound Beta | ★★ | Ricerca web + codice (agentic) |

---

## Import file e allegati

Clicca **+** nella barra di input per:
- **Carica file** — immagini, PDF, DOCX, XML, sorgenti
- **File attivo** — importa il file aperto nell'editor corrente
- **Selezione** — importa solo il testo selezionato

Oppure **trascina i file** direttamente nella finestra chat.

Incolla screenshot con **Ctrl+V**.

---

## Stack tecnologici

Clicca sulla barra stack (▾ configura) per impostare il contesto:

- **Laravel / PHP** — Laravel, MySQL, Blade, Livewire
- **React / TypeScript** — React, Next.js, TypeScript, Tailwind
- **Full Stack** — Laravel + React + MySQL
- **Node.js** — Node, Express, PostgreSQL, REST/GraphQL
- **WordPress** — WooCommerce, ACF, hooks
- **Prompt personalizzato** — scrivi il tuo system prompt

---

## Licenza

MIT — Sviluppato da [freewebsolution](https://github.com/freewebsolution/webdev) — Ing. Lucio Ticali

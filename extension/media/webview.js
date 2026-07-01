(function() {
  const vscode = acquireVsCodeApi();

  var providerStatus = { groq: false };
  var isStreaming = false;
  var currentAssistantBubble = null;
  var currentAssistantText = '';
  var conversationMessages = [];
  var autoTriageEnabled = false;
  var pendingFiles = [];
  var fileIdCounter = 0;

  function renderFileChips() {
    var container = document.getElementById('fileChips');
    if (!container) return;
    container.innerHTML = '';
    for (var i = 0; i < pendingFiles.length; i++) {
      var f = pendingFiles[i];
      var chip = document.createElement('div');
      chip.className = 'file-chip';
      var dims = (f.width && f.height) ? '<span class="chip-dims">' + f.width + '\xd7' + f.height + '</span>' : '';
      chip.innerHTML = '<span style="font-size:11px;flex-shrink:0">' + (f.type === 'image' ? '🖼' : '📄') + '</span>'
        + '<span class="chip-name" title="' + f.name + '">' + f.name + '</span>'
        + dims
        + '<button class="chip-remove" data-id="' + f.id + '">\xd7</button>';
      container.appendChild(chip);
    }
    container.style.display = pendingFiles.length ? 'flex' : 'none';
  }

  function addPendingImage(base64, mimeType, dataUrl, name) {
    var id = ++fileIdCounter;
    var img = new Image();
    img.onload = function() {
      pendingFiles.push({ id: id, type: 'image', base64: base64, mimeType: mimeType, dataUrl: dataUrl, name: name || 'image', width: img.naturalWidth, height: img.naturalHeight });
      renderFileChips();
    };
    img.src = dataUrl;
  }

  // Auto-triage: classifica il messaggio e sceglie il modello migliore
  function autoSelectModel(text, hasImage) {
    var lower = text.toLowerCase();
    var len = text.length;
    var hasCode = text.indexOf('```') !== -1 || /\bfunction\b|\bconst\b|\bclass\b|\bdef\b|\bimport\b/.test(text);

    // Immagine → vision
    if (hasImage) return { value: 'groq:meta-llama/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout' };

    // Ragionamento / matematica / logica → Qwen3 32B (solo per messaggi corti, limite free tier 6k token)
    if (/ragiona|spiega perch|dimostr|calcola|matematica|algoritmo|compless|ottimizza|analisi|confronta/.test(lower) && len <= 600) {
      return { value: 'groq:qwen/qwen3-32b', label: 'Qwen3 32B' };
    }
    // Messaggi lunghi → LLaMA 70B (più generoso con il free tier)
    if (len > 800) {
      return { value: 'groq:llama-3.3-70b-versatile', label: 'LLaMA 70B' };
    }

    // Code review / refactor / implementazione → GPT OSS 120B o LLaMA 70B
    if (hasCode || /review|refactor|implementa|analizza|architettur|scrivi|crea|migra|convertire/.test(lower)) {
      return { value: 'groq:openai/gpt-oss-120b', label: 'GPT OSS 120B' };
    }

    // Bug fix / errori → LLaMA 70B
    if (/fix|bug|error|errore|eccezione|exception|crash|warning|stack trace|non funziona/.test(lower)) {
      return { value: 'groq:llama-3.3-70b-versatile', label: 'LLaMA 70B' };
    }

    // Domande semplici → GPT OSS 20B (velocissimo)
    return { value: 'groq:openai/gpt-oss-20b', label: 'GPT OSS 20B' };
  }

  var MODEL_GROUPS = [
    {
      label: 'Generali',
      models: [
        { id: 'llama-3.3-70b-versatile', name: 'LLaMA 3.3 70B', hint: '🧠 Migliore' },
        { id: 'openai/gpt-oss-120b',     name: 'GPT OSS 120B',  hint: '🚀 120B' },
        { id: 'openai/gpt-oss-20b',      name: 'GPT OSS 20B',   hint: '⚡ 1000 tok/s' },
        { id: 'llama-3.1-8b-instant',    name: 'LLaMA 3.1 8B',  hint: '⚡ Veloce' },
      ]
    },
    {
      label: 'Ragionamento',
      models: [
        { id: 'qwen/qwen3-32b', name: 'Qwen3 32B', hint: '🔬 Reasoning' },
      ]
    },
    {
      label: 'Vision (Immagini)',
      models: [
        { id: 'meta-llama/llama-4-scout-17b-16e-instruct',     name: 'Llama 4 Scout',    hint: '👁 Vision' },
        { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', name: 'Llama 4 Maverick', hint: '👁 Vision' },
      ]
    },
    {
      label: 'Compound (Web + Codice)',
      models: [
        { id: 'compound-beta',      name: 'Compound Beta',      hint: '🔍 Agentic' },
        { id: 'compound-beta-mini', name: 'Compound Beta Mini', hint: '🔍 Leggero' },
      ]
    }
  ];

  function buildModelSelect() {
    var sel = document.getElementById('modelSelect');
    var previousValue = sel.value;
    sel.innerHTML = '';
    for (var gi = 0; gi < MODEL_GROUPS.length; gi++) {
      var grp = MODEL_GROUPS[gi];
      var optgrp = document.createElement('optgroup');
      optgrp.label = grp.label;
      for (var mi = 0; mi < grp.models.length; mi++) {
        var m = grp.models[mi];
        var opt = document.createElement('option');
        opt.value = 'groq:' + m.id;
        opt.textContent = m.hint ? m.name + '  ' + m.hint : m.name;
        optgrp.appendChild(opt);
      }
      sel.appendChild(optgrp);
    }
    if (previousValue) {
      for (var oi = 0; oi < sel.options.length; oi++) {
        if (sel.options[oi].value === previousValue) { sel.value = previousValue; return; }
      }
    }
  }

  function getSelectedProviderModel() {
    var val = document.getElementById('modelSelect').value;
    var colonIdx = val.indexOf(':');
    return { provider: val.substring(0, colonIdx), model: val.substring(colonIdx + 1) };
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function inlineRender(text) {
    var s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/_([^_]+)_/g, '<em>$1</em>');
    return s;
  }

  function renderMarkdown(text) {
    var html = '';
    var lines = text.split('\n');
    var inCodeBlock = false;
    var codeLines = [];
    var codeLang = '';
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('```') === 0) {
        if (!inCodeBlock) {
          inCodeBlock = true;
          codeLines = [];
          codeLang = line.slice(3).trim();
        } else {
          inCodeBlock = false;
          var codeHtml = escapeHtml(codeLines.join('\n'));
          html += '<div class="code-block">'
            + '<div class="code-header"><span>' + (codeLang || 'codice') + '</span>'
            + '<button class="copy-btn">Copia</button></div>'
            + '<pre><code>' + codeHtml + '</code></pre></div>';
          codeLines = [];
          codeLang = '';
        }
        continue;
      }
      if (inCodeBlock) { codeLines.push(line); continue; }
      if (line.indexOf('### ') === 0) { html += '<h3>' + inlineRender(line.slice(4)) + '</h3>'; continue; }
      if (line.indexOf('## ') === 0)  { html += '<h2>' + inlineRender(line.slice(3)) + '</h2>'; continue; }
      if (line.indexOf('# ') === 0)   { html += '<h1>' + inlineRender(line.slice(2)) + '</h1>'; continue; }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) { html += '<hr>'; continue; }
      if (/^[-*+] /.test(line)) { html += '<ul><li>' + inlineRender(line.slice(2)) + '</li></ul>'; continue; }
      if (/^\d+\. /.test(line)) { html += '<ol><li>' + inlineRender(line.replace(/^\d+\. /, '')) + '</li></ol>'; continue; }
      if (!line.trim()) { html += '<br>'; continue; }
      html += '<p>' + inlineRender(line) + '</p>';
    }
    // code block still open during streaming
    if (inCodeBlock && codeLines.length) {
      html += '<div class="code-block">'
        + '<div class="code-header"><span>' + (codeLang || 'codice') + '</span>'
        + '<button class="copy-btn">Copia</button></div>'
        + '<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre></div>';
    }
    html = html.replace(/<\/ul><ul>/g, '').replace(/<\/ol><ol>/g, '');
    return html;
  }

  function scrollToBottom() {
    var chat = document.getElementById('chat');
    chat.scrollTop = chat.scrollHeight;
  }

  function appendUserMessage(text, imageDataUrl) {
    var chat = document.getElementById('chat');
    var welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    var msg = document.createElement('div');
    msg.className = 'msg user';
    var inner = '';
    if (imageDataUrl) inner += '<img src="' + imageDataUrl + '" style="max-height:120px;max-width:100%;border-radius:5px;margin-bottom:4px;display:block;">';
    if (text) inner += '<div class="bubble">' + escapeHtml(text).replace(/\n/g, '<br>') + '</div>';
    msg.innerHTML = inner;
    chat.appendChild(msg);
    scrollToBottom();
  }

  function startAssistantMessage() {
    var chat = document.getElementById('chat');
    var welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    var msg = document.createElement('div');
    msg.className = 'msg assistant';
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';
    msg.appendChild(bubble);
    chat.appendChild(msg);
    currentAssistantBubble = bubble;
    currentAssistantText = '';
    scrollToBottom();
  }

  function appendChunk(text) {
    if (!currentAssistantBubble) return;
    currentAssistantText += text;
    currentAssistantBubble.innerHTML = renderMarkdown(currentAssistantText);
    scrollToBottom();
  }

  function finalizeAssistantMessage() {
    currentAssistantBubble = null;
    currentAssistantText = '';
    scrollToBottom();
  }

  function renderHistory(msgs) {
    var chat = document.getElementById('chat');
    var welcome = document.getElementById('welcome');
    if (welcome) welcome.remove();
    for (var i = 0; i < msgs.length; i++) {
      var m = msgs[i];
      if (m.role === 'user') {
        var imgUrl = m.image ? ('data:' + m.image.mimeType + ';base64,' + m.image.base64) : null;
        appendUserMessage(m.content, imgUrl);
      } else if (m.role === 'assistant') {
        var div = document.createElement('div');
        div.className = 'msg assistant';
        var bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.innerHTML = renderMarkdown(m.content);
        div.appendChild(bubble);
        chat.appendChild(div);
      }
    }
    scrollToBottom();
  }

  var SEND_ICON = '<svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5L3.5 7H6.5v7h3V7H12.5L8 1.5z"/></svg>';
  var STOP_ICON = '<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><rect x="1" y="1" width="10" height="10" rx="2"/></svg>';

  function setStreaming(v) {
    isStreaming = v;
    var sendBtn = document.getElementById('sendBtn');
    if (v) {
      sendBtn.innerHTML = STOP_ICON;
      sendBtn.title = 'Ferma';
      sendBtn.classList.add('stopping');
    } else {
      sendBtn.innerHTML = SEND_ICON;
      sendBtn.title = 'Invia (Enter)';
      sendBtn.classList.remove('stopping');
    }
  }

  function showError(msg) {
    var chat = document.getElementById('chat');
    var el = document.createElement('div');
    el.style.cssText = 'font-size:11px;color:var(--vscode-errorForeground,#f44);padding:4px 8px;background:rgba(244,68,68,.08);border-radius:4px;border:1px solid rgba(244,68,68,.2);margin:4px 0';
    el.textContent = 'Error: ' + msg;
    chat.appendChild(el);
    scrollToBottom();
  }

  function showToast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function() { t.classList.remove('show'); }, 2500);
  }

  function resizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }

  function updateSelectedPill(_provider) {}

  function sendMessage() {
    if (isStreaming) { vscode.postMessage({ type: 'cancel' }); return; }
    var textarea = document.getElementById('prompt');
    var text = textarea.value.trim();
    if (!text && pendingFiles.length === 0) return;
    var pm = getSelectedProviderModel();
    if (pm.model === '__none__') { showToast('Seleziona un modello valido'); return; }

    if (autoTriageEnabled) {
      var auto = autoSelectModel(text, pendingFiles.some(function(f) { return f.type === 'image'; }));
      var sel = document.getElementById('modelSelect');
      for (var oi = 0; oi < sel.options.length; oi++) {
        if (sel.options[oi].value === auto.value) { sel.value = auto.value; break; }
      }
      pm = getSelectedProviderModel();
      updateSelectedPill(pm.provider);
      showToast('🤖 Auto → ' + auto.label);
    }

    textarea.value = '';
    resizeTextarea(textarea);

    var msgObj = { role: 'user', content: text };
    var firstImg = null;
    for (var pi = 0; pi < pendingFiles.length; pi++) {
      if (pendingFiles[pi].type === 'image') { firstImg = pendingFiles[pi]; break; }
    }
    if (firstImg) {
      msgObj.image = { base64: firstImg.base64, mimeType: firstImg.mimeType };
    }
    var imageDataUrl = firstImg ? firstImg.dataUrl : null;
    pendingFiles = [];
    renderFileChips();

    appendUserMessage(text, imageDataUrl);
    conversationMessages.push(msgObj);

    setStreaming(true);
    startAssistantMessage();

    vscode.postMessage({ type: 'chat', messages: conversationMessages.slice(), model: pm.model, provider: pm.provider });
  }

  function updateStatus(providers) {
    providerStatus = providers;
    buildModelSelect();
  }

  // Copy code button — event delegation
  document.getElementById('chat').addEventListener('click', function(e) {
    var btn = e.target;
    if (!btn.classList.contains('copy-btn')) return;
    var code = btn.closest('.code-block').querySelector('code');
    if (!code) return;
    navigator.clipboard.writeText(code.textContent || '').then(function() {
      btn.textContent = '✓ Copiato';
      btn.classList.add('copied');
      setTimeout(function() {
        btn.textContent = 'Copia';
        btn.classList.remove('copied');
      }, 2000);
    });
  });

  // Image paste handler
  window.addEventListener('paste', function(e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        var blob = items[i].getAsFile();
        if (!blob) continue;
        var reader = new FileReader();
        reader.onload = function(ev) {
          var dataUrl = ev.target.result;
          var semicolon = dataUrl.indexOf(';');
          var comma = dataUrl.indexOf(',');
          var mimeType = dataUrl.substring(5, semicolon);
          var base64 = dataUrl.substring(comma + 1);
          addPendingImage(base64, mimeType, dataUrl, 'screenshot.png');
          showToast('Screenshot incollato — premi Invio per inviare');
        };
        reader.readAsDataURL(blob);
        e.preventDefault();
        break;
      }
    }
  });

  document.getElementById('fileChips').addEventListener('click', function(e) {
    var btn = e.target.closest ? e.target.closest('.chip-remove') : (e.target.className === 'chip-remove' ? e.target : null);
    if (!btn) return;
    var id = parseInt(btn.getAttribute('data-id'));
    pendingFiles = pendingFiles.filter(function(f) { return f.id !== id; });
    renderFileChips();
  });

  // Shared file processor — used by both drag & drop and file picker
  var MAX_FILE_SIZE = 20 * 1024 * 1024;

  function processFiles(files) {
    for (var i = 0; i < files.length; i++) {
      (function(file) {
        if (file.size > MAX_FILE_SIZE) {
          showToast('File troppo grande (max 20 MB): ' + file.name);
          return;
        }
        var ext = file.name.split('.').pop().toLowerCase();
        var isImage = file.type.startsWith('image/');
        var isDoc = ext === 'pdf' || ext === 'docx' || ext === 'xml';

        if (isImage) {
          var r = new FileReader();
          r.onload = (function(fname) { return function(ev) {
            var dataUrl = ev.target.result;
            var semicolon = dataUrl.indexOf(';');
            var comma = dataUrl.indexOf(',');
            addPendingImage(dataUrl.substring(comma + 1), dataUrl.substring(5, semicolon), dataUrl, fname);
            showToast('Immagine caricata: ' + fname);
          }; })(file.name);
          r.readAsDataURL(file);
        } else if (isDoc) {
          var r = new FileReader();
          r.onload = function(ev) {
            var uint8 = new Uint8Array(ev.target.result);
            var binary = '';
            var chunk = 8192;
            for (var j = 0; j < uint8.length; j += chunk) {
              binary += String.fromCharCode.apply(null, uint8.subarray(j, Math.min(j + chunk, uint8.length)));
            }
            vscode.postMessage({ type: 'extractDoc', name: file.name, data: btoa(binary) });
            showToast('Elaborazione: ' + file.name + '…');
          };
          r.readAsArrayBuffer(file);
        } else if (!isImage) {
          var r = new FileReader();
          r.onload = function(ev) {
            var textarea = document.getElementById('prompt');
            textarea.value += '\n```' + ext + '\n// ' + file.name + '\n' + ev.target.result + '\n```\n';
            resizeTextarea(textarea);
            showToast('Importato: ' + file.name);
          };
          r.readAsText(file);
        }
      })(files[i]);
    }
  }

  // Attach menu (+ button)
  var attachMenu = document.getElementById('attachMenu');

  function closeAttachMenu() {
    attachMenu.classList.remove('open');
  }

  document.getElementById('attachBtn').addEventListener('click', function(e) {
    e.stopPropagation();
    attachMenu.classList.toggle('open');
  });

  document.addEventListener('click', function() {
    closeAttachMenu();
  });

  attachMenu.addEventListener('click', function(e) {
    e.stopPropagation();
  });

  document.getElementById('menuFilePickerBtn').addEventListener('click', function() {
    closeAttachMenu();
    document.getElementById('fileInput').click();
  });

  document.getElementById('menuActiveFileBtn').addEventListener('click', function() {
    closeAttachMenu();
    vscode.postMessage({ type: 'importFile' });
  });

  document.getElementById('menuSelectionBtn').addEventListener('click', function() {
    closeAttachMenu();
    vscode.postMessage({ type: 'importSelection' });
  });

  document.getElementById('fileInput').addEventListener('change', function() {
    if (this.files && this.files.length > 0) {
      processFiles(this.files);
    }
    this.value = '';
  });

  // Drag & drop handler
  var dragCounter = 0;
  var dropOverlay = document.getElementById('dropOverlay');

  function typesHasFiles(types) {
    if (!types) return false;
    for (var i = 0; i < types.length; i++) {
      if (types[i] === 'Files' || types[i] === 'files') return true;
    }
    return false;
  }

  function resetDragState() {
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
  }

  document.addEventListener('dragenter', function(e) {
    if (e.dataTransfer && typesHasFiles(e.dataTransfer.types)) {
      dragCounter++;
      dropOverlay.classList.add('visible');
      e.preventDefault();
    }
  });

  document.addEventListener('dragleave', function(e) {
    if (e.dataTransfer && typesHasFiles(e.dataTransfer.types)) {
      dragCounter--;
      if (dragCounter <= 0) resetDragState();
    }
  });

  document.addEventListener('dragover', function(e) {
    if (e.dataTransfer && typesHasFiles(e.dataTransfer.types)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  window.addEventListener('blur', resetDragState);

  document.addEventListener('drop', function(e) {
    e.preventDefault();
    resetDragState();
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length > 0) processFiles(files);
  });

  // Event listeners
  document.getElementById('sendBtn').addEventListener('click', sendMessage);

  document.getElementById('prompt').addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  document.getElementById('prompt').addEventListener('input', function(e) {
    resizeTextarea(e.target);
  });

  document.getElementById('settingsBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'openSettings' });
  });

  document.getElementById('newChatBtn').addEventListener('click', function() {
    vscode.postMessage({ type: 'newSession' });
  });

  document.getElementById('stackBar').addEventListener('click', function() {
    vscode.postMessage({ type: 'configureTriage' });
  });

  document.getElementById('autoTriageBtn').addEventListener('click', function() {
    autoTriageEnabled = !autoTriageEnabled;
    this.classList.toggle('on', autoTriageEnabled);
    showToast(autoTriageEnabled ? '⚡ Auto Triage attivato' : 'Auto Triage disattivato');
  });

  document.getElementById('slashBtn').addEventListener('click', function() {
    var textarea = document.getElementById('prompt');
    textarea.focus();
    if (!textarea.value.startsWith('/')) textarea.value = '/' + textarea.value;
  });


  document.getElementById('modelSelect').addEventListener('change', function() {});

  // Messages from extension
  window.addEventListener('message', function(event) {
    var msg = event.data;
    switch (msg.type) {
      case 'chunk':
        appendChunk(msg.text);
        break;

      case 'done':
        if (currentAssistantText) conversationMessages.push({ role: 'assistant', content: currentAssistantText });
        finalizeAssistantMessage();
        setStreaming(false);
        vscode.postMessage({ type: 'saveHistory', messages: conversationMessages.slice() });
        break;

      case 'error':
        if (currentAssistantBubble) { currentAssistantBubble.innerHTML = ''; currentAssistantBubble = null; }
        setStreaming(false);
        showError(msg.message);
        break;

      case 'status':
        updateStatus(msg.providers);
        break;

      case 'fileImported': {
        var textarea = document.getElementById('prompt');
        textarea.value += '\n```' + msg.language + '\n// ' + msg.name + '\n' + msg.content + '\n```\n';
        resizeTextarea(textarea);
        showToast('Importato: ' + msg.name);
        break;
      }

      case 'docImported': {
        var textarea = document.getElementById('prompt');
        textarea.value += '\n[Documento: ' + msg.name + ']\n' + msg.content + '\n';
        resizeTextarea(textarea);
        showToast('Importato: ' + msg.name);
        break;
      }

      case 'toast':
        showToast(msg.message);
        break;

      case 'triageInfo':
        var labelEl = document.getElementById('stackLabel');
        if (labelEl) labelEl.textContent = 'Stack: ' + msg.stackLabel;
        break;

      case 'clearChat':
        var chat = document.getElementById('chat');
        chat.innerHTML = '<div class="welcome" id="welcome"><h3>WebDev AI — Groq</h3><p>Nuova sessione avviata.</p></div>';
        conversationMessages = [];
        setStreaming(false);
        currentAssistantBubble = null;
        currentAssistantText = '';
        vscode.postMessage({ type: 'saveHistory', messages: [] });
        break;

      case 'restoreHistory':
        if (!msg.messages || msg.messages.length === 0) break;
        if (msg.messages.length <= conversationMessages.length) break;
        conversationMessages = msg.messages.slice();
        document.getElementById('chat').innerHTML = '';
        renderHistory(msg.messages);
        break;

      case 'toast':
        showToast(msg.message);
        break;
    }
  });

  // Init
  buildModelSelect();
  updateSelectedPill(getSelectedProviderModel().provider);
  vscode.postMessage({ type: 'getStatus' });
})();

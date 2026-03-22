(() => {
  'use strict';

  // ── Tab switching ──
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`section-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'rewrite') loadRewritePrompts();
    });
  });

  // ── API Settings ──
  async function loadApiSettings() {
    const config = await StorageManager.getApiConfig();
    document.getElementById('api-base-url').value = config.baseUrl || '';
    document.getElementById('api-key').value       = config.apiKey  || '';
    document.getElementById('api-model').value     = config.model   || '';
  }

  document.getElementById('btn-save-api').addEventListener('click', async () => {
    await StorageManager.saveApiConfig({
      baseUrl: document.getElementById('api-base-url').value.trim(),
      apiKey:  document.getElementById('api-key').value.trim(),
      model:   document.getElementById('api-model').value.trim(),
    });
    const s = document.getElementById('api-status');
    s.className = 'success'; s.textContent = '✓ Settings saved!';
    setTimeout(() => { s.textContent = ''; s.className = ''; }, 2500);
  });

  // ── Saved Prompts tab ──
  let editingPromptId = null;
  const promptList   = document.getElementById('prompt-list');
  const promptEditor = document.getElementById('prompt-editor');
  const editorTitle  = document.getElementById('editor-title');
  const editorSystem = document.getElementById('editor-system');

  async function renderPrompts() {
    const prompts   = await StorageManager.getPrompts();
    const defaultId = await StorageManager.getDefaultPromptId();
    promptList.innerHTML = '';
    if (!prompts.length) {
      promptList.innerHTML = '<div class="empty-state">No prompts yet.<br>Click "+ New" to create one.</div>';
      return;
    }
    prompts.forEach(p => {
      const isDefault = p.id === defaultId;
      const card = document.createElement('div');
      card.className = 'prompt-card' + (isDefault ? ' is-default' : '');
      card.innerHTML = `
        <div class="prompt-card-header">
          <span class="prompt-card-title">
            ${esc(p.title)}
            ${isDefault ? '<span class="default-badge">Default</span>' : ''}
          </span>
          <div class="prompt-card-actions">
            ${!isDefault ? `<button data-action="default" data-id="${p.id}" title="Set default">★</button>` : ''}
            <button data-action="edit"   data-id="${p.id}" title="Edit">✎</button>
            <button data-action="delete" data-id="${p.id}" title="Delete">✕</button>
          </div>
        </div>
        <div class="prompt-card-body">${esc(p.systemPrompt)}</div>`;
      promptList.appendChild(card);
    });
    promptList.querySelectorAll('[data-action]').forEach(btn => btn.addEventListener('click', async e => {
      const { action, id } = e.currentTarget.dataset;
      if (action === 'delete') { await StorageManager.deletePrompt(id); await renderPrompts(); await loadRewritePrompts(); }
      else if (action === 'default') { await StorageManager.setDefaultPromptId(id); await renderPrompts(); await loadRewritePrompts(); }
      else if (action === 'edit') {
        const prompt = (await StorageManager.getPrompts()).find(p => p.id === id);
        if (prompt) { editingPromptId = id; editorTitle.value = prompt.title; editorSystem.value = prompt.systemPrompt; promptEditor.classList.add('active'); editorTitle.focus(); }
      }
    }));
  }

  document.getElementById('btn-add-prompt').addEventListener('click', () => {
    editingPromptId = null; editorTitle.value = ''; editorSystem.value = '';
    promptEditor.classList.add('active'); editorTitle.focus();
  });
  document.getElementById('btn-cancel-prompt').addEventListener('click', () => { promptEditor.classList.remove('active'); editingPromptId = null; });
  document.getElementById('btn-save-prompt').addEventListener('click', async () => {
    const title = editorTitle.value.trim(), systemPrompt = editorSystem.value.trim();
    if (!title || !systemPrompt) return;
    const prompt = { id: editingPromptId || StorageManager.generateId(), title, systemPrompt };
    await StorageManager.savePrompt(prompt);
    const all = await StorageManager.getPrompts();
    if (all.length === 1) await StorageManager.setDefaultPromptId(prompt.id);
    promptEditor.classList.remove('active'); editingPromptId = null;
    await renderPrompts(); await loadRewritePrompts();
  });

  // ── Rewrite Tab ──
  const cbInput      = document.getElementById('cb-input');
  const cbOutput     = document.getElementById('cb-output');
  const cbOutputWrap = document.getElementById('cb-output-wrap');
  const cbStatus     = document.getElementById('cb-status');
  const cbPromptList = document.getElementById('cb-prompt-list');

  function setCbStatus(msg, type = '') {
    cbStatus.textContent = msg; cbStatus.className = type;
    if (msg && type !== 'loading') setTimeout(() => { cbStatus.textContent = ''; cbStatus.className = ''; }, 3000);
  }

  async function loadRewritePrompts() {
    const prompts   = await StorageManager.getPrompts();
    const defaultId = await StorageManager.getDefaultPromptId();
    cbPromptList.innerHTML = '';
    if (!prompts.length) {
      cbPromptList.innerHTML = '<span style="font-size:12px;color:var(--gray-400)">No saved prompts — add them in the Prompts tab.</span>';
      return;
    }
    prompts.forEach(p => {
      const chip = document.createElement('button');
      chip.className = 'cb-chip' + (p.id === defaultId ? ' cb-default' : '');
      chip.textContent = p.title;
      chip.addEventListener('click', () => runRewrite(p.systemPrompt));
      cbPromptList.appendChild(chip);
    });
  }

  document.getElementById('cb-run-custom').addEventListener('click', () => {
    const instruction = document.getElementById('cb-custom-input').value.trim();
    if (!instruction) { setCbStatus('Type a custom instruction first.', 'error'); return; }
    runRewrite(instruction);
  });
  document.getElementById('cb-custom-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('cb-run-custom').click(); }
  });

  async function runRewrite(systemPrompt) {
    const text = cbInput.value.trim();
    if (!text) { setCbStatus('Paste some text first.', 'error'); return; }

    const config = await StorageManager.getApiConfig();
    if (!config.apiKey) { setCbStatus('No API key — go to API tab.', 'error'); return; }

    document.querySelectorAll('.cb-chip').forEach(c => c.classList.add('cb-running'));
    setCbStatus('⏳ Rewriting…', 'loading');
    cbOutput.value = '';

    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
        body: JSON.stringify({
          model: config.model, stream: true,
          messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: text }],
        }),
      });

      if (!response.ok) {
        let msg = `API error ${response.status}`;
        try { const b = await response.json(); msg = b.error?.message || msg; } catch {}
        setCbStatus(msg, 'error'); return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data: ')) continue;
          const d = t.slice(6); if (d === '[DONE]') continue;
          try { const token = JSON.parse(d).choices?.[0]?.delta?.content; if (token) { cbOutput.value += token; cbOutput.scrollTop = cbOutput.scrollHeight; } } catch {}
        }
      }
      setCbStatus('✓ Done!');
      setTimeout(() => { cbStatus.textContent = ''; cbStatus.className = ''; }, 2000);
    } catch (err) {
      setCbStatus(err.message || 'Something went wrong.', 'error');
    } finally {
      document.querySelectorAll('.cb-chip').forEach(c => c.classList.remove('cb-running'));
    }
  }

  // Copy result button
  document.getElementById('btn-copy-result').addEventListener('click', async () => {
    const btn = document.getElementById('btn-copy-result');
    if (!cbOutput.value) { setCbStatus('Nothing to copy yet.', 'error'); return; }
    try {
      await navigator.clipboard.writeText(cbOutput.value);
      btn.classList.add('copied');
      btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy`;
      }, 2000);
    } catch { setCbStatus('Could not copy.', 'error'); }
  });

  function esc(str) { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; }

  // ── Init — load rewrite tab first since it's the default ──
  loadApiSettings();
  renderPrompts();
  loadRewritePrompts();
})();

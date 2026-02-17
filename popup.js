/**
 * Rewritely Popup Script
 * Manages API configuration and prompt CRUD.
 */
(() => {
  'use strict';

  // ── DOM refs ──
  const tabs = document.querySelectorAll('.tab');
  const sections = document.querySelectorAll('.section');

  const apiBaseUrl = document.getElementById('api-base-url');
  const apiKey = document.getElementById('api-key');
  const apiModel = document.getElementById('api-model');
  const btnSaveApi = document.getElementById('btn-save-api');
  const apiStatus = document.getElementById('api-status');

  const promptList = document.getElementById('prompt-list');
  const promptEditor = document.getElementById('prompt-editor');
  const editorTitle = document.getElementById('editor-title');
  const editorSystem = document.getElementById('editor-system');
  const btnAddPrompt = document.getElementById('btn-add-prompt');
  const btnSavePrompt = document.getElementById('btn-save-prompt');
  const btnCancelPrompt = document.getElementById('btn-cancel-prompt');

  let editingPromptId = null;

  // ── Tab switching ──

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('active'));
      sections.forEach((s) => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`section-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // ── API Settings ──

  async function loadApiSettings() {
    const config = await StorageManager.getApiConfig();
    apiBaseUrl.value = config.baseUrl || '';
    apiKey.value = config.apiKey || '';
    apiModel.value = config.model || '';
  }

  btnSaveApi.addEventListener('click', async () => {
    await StorageManager.saveApiConfig({
      baseUrl: apiBaseUrl.value.trim(),
      apiKey: apiKey.value.trim(),
      model: apiModel.value.trim(),
    });

    apiStatus.className = 'api-status success';
    apiStatus.textContent = 'Settings saved!';
    setTimeout(() => { apiStatus.textContent = ''; apiStatus.className = ''; }, 2000);
  });

  // ── Prompts ──

  async function renderPrompts() {
    const prompts = await StorageManager.getPrompts();
    const defaultId = await StorageManager.getDefaultPromptId();

    promptList.innerHTML = '';

    if (prompts.length === 0) {
      promptList.innerHTML = '<div class="empty-state">No prompts yet. Click "+ New" to create one.</div>';
      return;
    }

    prompts.forEach((prompt) => {
      const card = document.createElement('div');
      card.className = 'prompt-card' + (prompt.id === defaultId ? ' is-default' : '');

      const isDefault = prompt.id === defaultId;

      card.innerHTML = `
        <div class="prompt-card-header">
          <span class="prompt-card-title">
            ${escapeHtml(prompt.title)}
            ${isDefault ? '<span class="default-badge">Default</span>' : ''}
          </span>
          <div class="prompt-card-actions">
            ${!isDefault ? `<button class="btn btn-ghost btn-sm" data-action="default" data-id="${prompt.id}" title="Set as default">&#9733;</button>` : ''}
            <button class="btn btn-ghost btn-sm" data-action="edit" data-id="${prompt.id}" title="Edit">&#9998;</button>
            <button class="btn btn-ghost btn-sm" data-action="delete" data-id="${prompt.id}" title="Delete">&times;</button>
          </div>
        </div>
        <div class="prompt-card-body">${escapeHtml(prompt.systemPrompt)}</div>
      `;

      promptList.appendChild(card);
    });

    // Attach card action listeners
    promptList.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', handlePromptAction);
    });
  }

  async function handlePromptAction(e) {
    const action = e.currentTarget.dataset.action;
    const id = e.currentTarget.dataset.id;

    if (action === 'delete') {
      await StorageManager.deletePrompt(id);
      await renderPrompts();
    } else if (action === 'default') {
      await StorageManager.setDefaultPromptId(id);
      await renderPrompts();
    } else if (action === 'edit') {
      const prompts = await StorageManager.getPrompts();
      const prompt = prompts.find((p) => p.id === id);
      if (prompt) {
        editingPromptId = prompt.id;
        editorTitle.value = prompt.title;
        editorSystem.value = prompt.systemPrompt;
        promptEditor.classList.add('active');
      }
    }
  }

  // ── Prompt Editor ──

  btnAddPrompt.addEventListener('click', () => {
    editingPromptId = null;
    editorTitle.value = '';
    editorSystem.value = '';
    promptEditor.classList.add('active');
    editorTitle.focus();
  });

  btnCancelPrompt.addEventListener('click', () => {
    promptEditor.classList.remove('active');
    editingPromptId = null;
  });

  btnSavePrompt.addEventListener('click', async () => {
    const title = editorTitle.value.trim();
    const systemPrompt = editorSystem.value.trim();
    if (!title || !systemPrompt) return;

    const prompt = {
      id: editingPromptId || StorageManager.generateId(),
      title,
      systemPrompt,
    };

    await StorageManager.savePrompt(prompt);

    // If this is the first prompt, make it default
    const prompts = await StorageManager.getPrompts();
    if (prompts.length === 1) {
      await StorageManager.setDefaultPromptId(prompt.id);
    }

    promptEditor.classList.remove('active');
    editingPromptId = null;
    await renderPrompts();
  });

  // ── Utils ──

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Init ──

  loadApiSettings();
  renderPrompts();
})();

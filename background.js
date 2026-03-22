/**
 * Rewritely Background Service Worker
 * Handles API calls securely (API key never exposed to page context).
 * Streams responses back to content script via messaging ports.
 */

const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

// ── Storage helpers (duplicated minimally since service worker can't share content script modules) ──

const STORAGE_KEYS = {
  API_CONFIG: 'bgm_api_config',
  PROMPTS: 'bgm_prompts',
  DEFAULT_PROMPT_ID: 'bgm_default_prompt_id',
};

async function storageGet(key) {
  return new Promise((resolve) => {
    browserAPI.storage.local.get(key, (result) => resolve(result[key]));
  });
}

async function getApiConfig() {
  return (await storageGet(STORAGE_KEYS.API_CONFIG)) || {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
  };
}

async function getPromptById(promptId) {
  const prompts = (await storageGet(STORAGE_KEYS.PROMPTS)) || [];
  return prompts.find((p) => p.id === promptId) || null;
}

async function getDefaultPrompt() {
  const prompts = (await storageGet(STORAGE_KEYS.PROMPTS)) || [];
  const defaultId = await storageGet(STORAGE_KEYS.DEFAULT_PROMPT_ID);
  return prompts.find((p) => p.id === defaultId) || prompts[0] || null;
}

// ── Streaming API call ──

async function streamCompletion(port, { text, promptId }) {
  try {
    const config = await getApiConfig();
    if (!config.apiKey) {
      port.postMessage({ type: 'error', error: 'API key not configured. Open Rewritely settings.' });
      return;
    }

    const prompt = promptId ? await getPromptById(promptId) : await getDefaultPrompt();
    if (!prompt) {
      port.postMessage({ type: 'error', error: 'No prompt configured. Open Rewritely settings.' });
      return;
    }

    const url = `${config.baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        messages: [
          { role: 'system', content: prompt.systemPrompt },
          { role: 'user', content: text },
        ],
      }),
    });

    if (!response.ok) {
      let errMsg = `API error: ${response.status}`;
      try {
        const errBody = await response.json();
        errMsg = errBody.error?.message || errMsg;
      } catch (_) {}
      port.postMessage({ type: 'error', error: errMsg });
      return;
    }

    port.postMessage({ type: 'stream_start' });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) {
            port.postMessage({ type: 'stream_token', token });
          }
        } catch (_) {
          // Skip malformed chunks
        }
      }
    }

    port.postMessage({ type: 'stream_end' });
  } catch (err) {
    port.postMessage({ type: 'error', error: err.message || 'Unknown error' });
  }
}


// ── Quick prompt (one-off system prompt, no stored prompt needed) ──

async function streamCompletionQuick(port, { text, systemPrompt }) {
  try {
    const config = await getApiConfig();
    if (!config.apiKey) {
      port.postMessage({ type: 'error', error: 'API key not configured. Open Rewritely settings.' });
      return;
    }

    const url = `${config.baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: text },
        ],
      }),
    });

    if (!response.ok) {
      let errMsg = `API error: ${response.status}`;
      try { const errBody = await response.json(); errMsg = errBody.error?.message || errMsg; } catch (_) {}
      port.postMessage({ type: 'error', error: errMsg });
      return;
    }

    port.postMessage({ type: 'stream_start' });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const token = parsed.choices?.[0]?.delta?.content;
          if (token) port.postMessage({ type: 'stream_token', token });
        } catch (_) {}
      }
    }

    port.postMessage({ type: 'stream_end' });
  } catch (err) {
    port.postMessage({ type: 'error', error: err.message || 'Unknown error' });
  }
}

// ── Message handling via long-lived ports for streaming ──

browserAPI.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bgm-stream') return;

  let aborted = false;

  port.onMessage.addListener((msg) => {
    if (msg.type === 'rewrite') {
      streamCompletion(port, msg);
    } else if (msg.type === 'rewrite_quick') {
      streamCompletionQuick(port, msg);
    } else if (msg.type === 'abort') {
      aborted = true;
    }
  });

  port.onDisconnect.addListener(() => {
    aborted = true;
  });
});

// ── Simple message handler for non-streaming requests ──

browserAPI.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'get_prompts') {
    (async () => {
      const prompts = (await storageGet(STORAGE_KEYS.PROMPTS)) || [];
      const defaultId = await storageGet(STORAGE_KEYS.DEFAULT_PROMPT_ID);
      sendResponse({ prompts, defaultId });
    })();
    return true;
  }

  if (msg.type === 'get_api_config') {
    (async () => {
      const config = await getApiConfig();
      sendResponse(config);
    })();
    return true;
  }
});

// ── Context menu ──

function createContextMenu() {
  browserAPI.contextMenus.removeAll(() => {
    browserAPI.contextMenus.create({
      id: 'bgm-rewrite',
      title: 'Rewrite with Rewritely',
      contexts: ['selection'],
    });
  });
}

browserAPI.runtime.onInstalled.addListener(createContextMenu);
browserAPI.runtime.onStartup.addListener(createContextMenu);

browserAPI.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'bgm-rewrite' && tab?.id) {
    browserAPI.tabs.sendMessage(tab.id, { type: 'trigger_rewrite' });
  }
});

// ── Keyboard shortcut ──

browserAPI.commands.onCommand.addListener((command) => {
  if (command === 'trigger-rewrite') {
    browserAPI.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        browserAPI.tabs.sendMessage(tabs[0].id, { type: 'trigger_rewrite' });
      }
    });
  }
});

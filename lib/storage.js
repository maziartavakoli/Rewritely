/**
 * Rewritely Storage Manager
 * Handles all persistent storage operations for API config and prompts.
 */
const StorageManager = (() => {
  const KEYS = {
    API_CONFIG: 'bgm_api_config',
    PROMPTS: 'bgm_prompts',
    DEFAULT_PROMPT_ID: 'bgm_default_prompt_id',
  };

  const DEFAULT_API_CONFIG = {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
  };

  const DEFAULT_PROMPTS = [
    {
      id: 'default-grammar-pro',
      title: 'Fix Grammar – Professional',
      systemPrompt: 'You are a professional editor. Rewrite the text to fix grammar and improve clarity while keeping a formal tone. Output ONLY the corrected text, nothing else.',
    },
    {
      id: 'default-grammar-casual',
      title: 'Fix Grammar – Casual',
      systemPrompt: 'You are a friendly writing assistant. Fix grammar and spelling mistakes while keeping the tone casual and natural. Output ONLY the corrected text, nothing else.',
    },
    {
      id: 'default-concise',
      title: 'Make Concise',
      systemPrompt: 'Rewrite the text to be more concise and to the point. Remove unnecessary words while preserving the original meaning. Output ONLY the rewritten text, nothing else.',
    },
  ];

  // Use chrome.storage API (works in both Chrome and Firefox with MV3)
  const storage = (typeof browser !== 'undefined' ? browser : chrome).storage.local;

  async function get(key) {
    return new Promise((resolve) => {
      storage.get(key, (result) => resolve(result[key]));
    });
  }

  async function set(key, value) {
    return new Promise((resolve) => {
      storage.set({ [key]: value }, resolve);
    });
  }

  return {
    async getApiConfig() {
      const config = await get(KEYS.API_CONFIG);
      return config || { ...DEFAULT_API_CONFIG };
    },

    async saveApiConfig(config) {
      await set(KEYS.API_CONFIG, {
        baseUrl: (config.baseUrl || '').replace(/\/+$/, ''),
        apiKey: config.apiKey || '',
        model: config.model || 'gpt-4o-mini',
      });
    },

    async getPrompts() {
      const prompts = await get(KEYS.PROMPTS);
      if (!prompts || prompts.length === 0) {
        await set(KEYS.PROMPTS, DEFAULT_PROMPTS);
        await set(KEYS.DEFAULT_PROMPT_ID, DEFAULT_PROMPTS[0].id);
        return [...DEFAULT_PROMPTS];
      }
      return prompts;
    },

    async savePrompt(prompt) {
      const prompts = await this.getPrompts();
      const idx = prompts.findIndex((p) => p.id === prompt.id);
      if (idx >= 0) {
        prompts[idx] = prompt;
      } else {
        prompts.push(prompt);
      }
      await set(KEYS.PROMPTS, prompts);
      return prompts;
    },

    async deletePrompt(promptId) {
      let prompts = await this.getPrompts();
      prompts = prompts.filter((p) => p.id !== promptId);
      await set(KEYS.PROMPTS, prompts);

      const defaultId = await get(KEYS.DEFAULT_PROMPT_ID);
      if (defaultId === promptId && prompts.length > 0) {
        await set(KEYS.DEFAULT_PROMPT_ID, prompts[0].id);
      }
      return prompts;
    },

    async getDefaultPromptId() {
      const id = await get(KEYS.DEFAULT_PROMPT_ID);
      if (!id) {
        const prompts = await this.getPrompts();
        if (prompts.length > 0) {
          await set(KEYS.DEFAULT_PROMPT_ID, prompts[0].id);
          return prompts[0].id;
        }
      }
      return id;
    },

    async setDefaultPromptId(promptId) {
      await set(KEYS.DEFAULT_PROMPT_ID, promptId);
    },

    async getDefaultPrompt() {
      const prompts = await this.getPrompts();
      const defaultId = await this.getDefaultPromptId();
      return prompts.find((p) => p.id === defaultId) || prompts[0] || null;
    },

    generateId() {
      return 'prompt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    },
  };
})();

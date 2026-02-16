# Rewritely

AI-powered browser extension that rewrites, fixes grammar, and transforms your writing directly inside any input field — with streaming output.

## What It Does

Select text in any text field on any website, click the floating action button, pick a prompt, and watch the AI rewrite your text in real-time. The result streams directly back into the same field, replacing the original.

**Use cases:**
- Fix grammar and spelling
- Change tone (formal, casual, concise)
- Rewrite for clarity
- Any custom transformation via configurable prompts

## Features

- **Floating action button** — appears next to your cursor when you select text in an input field
- **Prompt selector** — choose from multiple saved prompts on click
- **Streaming output** — tokens appear live in the field as the AI generates them
- **Configurable API** — works with any OpenAI-compatible endpoint (OpenAI, Azure, local LLMs, etc.)
- **Prompt management** — create, edit, delete, and set a default prompt
- **Multiple triggers** — floating icon, `Alt+R` keyboard shortcut, right-click context menu
- **Secure** — API key stored in extension storage, all API calls from the background worker (never exposed to page context)
- **Cross-browser** — Chrome (MV3) and Firefox compatible

## Supported Input Types

- `<textarea>`
- `<input>` (text, search, email, url, tel, password)
- `contentEditable` elements

## Installation

### Chrome

1. Go to `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the project folder

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on**
3. Select `manifest.json` from the project folder

> For permanent Firefox distribution, add to manifest.json:
> ```json
> "browser_specific_settings": {
>   "gecko": { "id": "rewritely@example.com" }
> }
> ```

## Setup

1. Click the Rewritely extension icon
2. Go to the **API Settings** tab
3. Enter your base URL (e.g. `https://api.openai.com/v1`), API key, and model name
4. Click **Save Settings**
5. Go to the **Prompts** tab — three default prompts are included, or create your own

## How It Works

```
User selects text in input field
        |
Floating icon appears near cursor
        |
User clicks icon -> prompt selector opens
        |
User picks a prompt
        |
Content script sends text + prompt ID to background worker via port
        |
Background worker calls OpenAI-compatible API with streaming enabled
        |
Tokens stream back through the port to the content script
        |
Content script injects tokens live into the input field
        |
Original text is fully replaced
```

## Project Structure

```
rewritely/
├── manifest.json          MV3 manifest
├── background.js          Service worker — API proxy with SSE streaming
├── content.js             Content script — selection detection, floating UI, stream injection
├── content.css            Floating button and prompt selector styles
├── popup.html             Popup shell
├── popup.css              Popup styles
├── popup.js               Popup logic — tabs, API config, prompt CRUD
├── lib/
│   └── storage.js         Storage abstraction for settings and prompts
└── icon.png               Extension icon
```

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Alt+R`  | Rewrite selected text with the default prompt |

## Security

- API key is stored only in `browser.storage.local` — never injected into page context
- All API calls are made from the background service worker
- Content script only sends/receives text and tokens via extension messaging

## License

MIT

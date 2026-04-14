# Rewritely

Rewritely is a Manifest V3 browser extension that rewrites selected text with an OpenAI-compatible API. It works directly inside editable fields on web pages and also includes a popup workspace for paste-in/paste-out rewrites.

## What Changed

The extension now supports two rewrite flows:

- In-page rewriting from a floating action button after selecting text on a site
- Popup-based rewriting from a dedicated `Rewrite` tab with saved prompts or one-off instructions

It also handles more than plain text inputs:

- `textarea`
- text-like `input` elements
- `contentEditable` editors
- selected non-editable page text, returned in a copyable toast

## Features

- Floating rewrite button near selected text
- Prompt picker with saved prompts and a custom one-off instruction field
- Streaming output back into the page as tokens arrive
- Popup rewrite workspace with input, result, and copy action
- Prompt management: create, edit, delete, and set default prompts
- API settings for any OpenAI-compatible `/chat/completions` endpoint
- Keyboard shortcut: `Alt+R`
- Context menu entry: `Rewrite with Rewritely`

## How It Works

### In-page rewrite

1. Select text on a page.
2. Rewritely shows a floating button.
3. Click the button and choose a saved prompt or enter a custom instruction.
4. The content script sends the request to the background service worker over a port.
5. The background worker calls the configured API with streaming enabled.
6. Tokens stream back and are inserted into the active field live.

If the selected text is not inside an editable element, Rewritely shows the streamed result in a toast with a copy button instead of injecting it into the page.

### Popup rewrite

1. Open the extension popup.
2. Use the `Rewrite` tab.
3. Paste text, choose a saved prompt or type a custom instruction.
4. The popup streams the result into the output box.

## Supported Editors

Rewritely targets:

- `textarea`
- `input[type="text" | "search" | "url" | "email" | "tel" | "password"]`
- `contentEditable` editors

The content script is designed to work with richer editors that rely on contenteditable behavior, including tools like Slack, Notion, and similar web editors.

## Installation

### Chrome

1. Open `chrome://extensions/`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this project folder

### Firefox

1. Open `about:debugging#/runtime/this-firefox`
2. Click `Load Temporary Add-on`
3. Select `manifest.json`

For a persistent Firefox build, add `browser_specific_settings.gecko.id` to `manifest.json`.

## Setup

1. Open the extension popup.
2. In the `API` tab, configure:
   - Base URL, for example `https://api.openai.com/v1`
   - API key
   - Model, for example `gpt-4o-mini`
3. Save settings.
4. In the `Prompts` tab, keep the defaults or add your own system prompts.

## Project Structure

```text
.
├── manifest.json
├── background.js
├── content.js
├── content.css
├── popup.html
├── popup.css
├── popup.js
├── lib/
│   └── storage.js
└── icon*.png
```

### File Roles

- `background.js`: streaming API proxy for in-page rewrites, context menu, keyboard shortcut
- `content.js`: selection detection, floating UI, prompt menu, text injection, non-editable toast fallback
- `popup.js`: popup tabs, rewrite workspace, prompt CRUD, API settings
- `lib/storage.js`: local storage for API config, prompts, and default prompt

## Permissions

- `storage`: saves API config and prompts
- `contextMenus`: adds the right-click rewrite action
- host permissions on `http://*/*` and `https://*/*`: allows the extension to run on pages and call configured API endpoints

## Security Notes

- API keys are stored in extension local storage.
- In-page rewrites send requests through the background worker, so page scripts do not receive the API key.
- Popup rewrites are executed from the extension popup itself, not from page context.

## Default Prompt Set

The extension seeds three prompts on first run:

- `Fix Grammar – Professional`
- `Fix Grammar – Casual`
- `Make Concise`

## License

MIT

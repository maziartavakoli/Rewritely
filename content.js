/**
 * Rewritely Content Script
 * Detects text selection in input fields, shows floating action icon,
 * and streams AI-rewritten text back into the field.
 *
 * Supports: <input>, <textarea>, and contentEditable elements
 * including rich text editors (Slack/Quill, Notion, Google Docs-style, etc.)
 */
(() => {
  'use strict';

  const browserAPI = (typeof browser !== 'undefined') ? browser : chrome;

  // ── Extension context check ──

  function isContextValid() {
    try {
      return !!browserAPI.runtime?.id;
    } catch (_) {
      return false;
    }
  }

  let contextDead = false;

  function handleInvalidContext() {
    if (contextDead) return;
    contextDead = true;
    console.warn('[Rewritely] Extension was reloaded. Refresh the page to re-enable.');
    cleanup();
  }

  function handleContextError(err) {
    if (err && err.message && err.message.includes('Extension context invalidated')) {
      handleInvalidContext();
    } else {
      console.error('[Rewritely]', err);
    }
  }

  function cleanup() {
    try { hideFloatingBtn(); } catch (_) {}
    try {
      if (floatingBtn && floatingBtn.parentNode) floatingBtn.parentNode.removeChild(floatingBtn);
      if (promptSelector && promptSelector.parentNode) promptSelector.parentNode.removeChild(promptSelector);
    } catch (_) {}
    floatingBtn = null;
    promptSelector = null;
    try { observer.disconnect(); } catch (_) {}
  }

  /** Safe wrapper around runtime.sendMessage that catches sync throws. */
  function sendRuntimeMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        browserAPI.runtime.sendMessage(msg, (res) => {
          try {
            if (browserAPI.runtime.lastError) {
              reject(new Error(browserAPI.runtime.lastError.message));
            } else {
              resolve(res);
            }
          } catch (e) {
            reject(e);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  // ── State ──
  let activeElement = null;
  let selectedText = '';
  let selectionStart = 0;
  let selectionEnd = 0;
  let savedRange = null; // preserved Selection range for contenteditable
  let isStreaming = false;
  let floatingBtn = null;
  let promptSelector = null;
  let currentPort = null;

  // ── Helpers ──

  function isNativeInput(el) {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      return ['text', 'search', 'url', 'email', 'tel', 'password'].includes(type);
    }
    return false;
  }

  /**
   * Find the nearest contentEditable element from a given node.
   * Walks up the DOM tree. Stops at <body>.
   */
  function findContentEditable(node) {
    let el = node;
    while (el && el !== document.body && el !== document.documentElement) {
      if (el.nodeType === Node.ELEMENT_NODE && el.isContentEditable) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  /**
   * Resolve the actual editable element from multiple signals:
   * 1. The direct event target
   * 2. document.activeElement (may be a wrapper in Slack etc.)
   * 3. The selection's anchor node (most reliable for contenteditable)
   */
  function resolveEditableElement(eventTarget) {
    // 1. Native <input>/<textarea> — activeElement is reliable
    const active = document.activeElement;
    if (isNativeInput(active)) return active;

    // 2. Try the selection's anchor node — most reliable for contenteditable
    const sel = window.getSelection();
    if (sel && sel.anchorNode) {
      const ceFromSel = findContentEditable(sel.anchorNode);
      if (ceFromSel) return ceFromSel;
    }

    // 3. Walk up from event target
    if (eventTarget) {
      const ceFromTarget = findContentEditable(eventTarget);
      if (ceFromTarget) return ceFromTarget;
    }

    // 4. Walk up from activeElement
    if (active) {
      const ceFromActive = findContentEditable(active);
      if (ceFromActive) return ceFromActive;
    }

    return null;
  }

  function isEditableElement(el) {
    if (!el) return false;
    return isNativeInput(el) || el.isContentEditable;
  }

  function getSelectedText(el) {
    if (!el) return '';
    if (isNativeInput(el)) {
      if (typeof el.selectionStart === 'number') {
        return el.value.substring(el.selectionStart, el.selectionEnd);
      }
      return '';
    }
    // contenteditable — use window.getSelection
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      // Verify selection is within this element
      if (sel.anchorNode && el.contains(sel.anchorNode)) {
        return sel.toString();
      }
    }
    return '';
  }

  /**
   * Save the current selection range so we can restore it later
   * (clicking the floating button will steal focus/selection).
   */
  function saveSelection(el) {
    if (isNativeInput(el)) {
      selectionStart = el.selectionStart;
      selectionEnd = el.selectionEnd;
      savedRange = null;
    } else {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        savedRange = sel.getRangeAt(0).cloneRange();
      }
      selectionStart = 0;
      selectionEnd = 0;
    }
  }

  function restoreSelection(el) {
    if (isNativeInput(el)) {
      el.focus();
      el.setSelectionRange(selectionStart, selectionEnd);
    } else if (savedRange) {
      el.focus();
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  }

  function getCaretCoords(el) {
    // For contenteditable, use the selection range bounding rect
    if (el.isContentEditable) {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          return { top: rect.top + window.scrollY, left: rect.right + window.scrollX };
        }
      }
      // Fallback: use element position
      const elRect = el.getBoundingClientRect();
      return { top: elRect.top + window.scrollY, left: elRect.right + window.scrollX };
    }

    // For input/textarea — mirror div approach
    const rect = el.getBoundingClientRect();
    if (typeof el.selectionEnd === 'number') {
      const mirror = document.createElement('div');
      const style = getComputedStyle(el);
      const props = [
        'font', 'letterSpacing', 'wordSpacing', 'textIndent',
        'paddingLeft', 'paddingTop', 'borderLeftWidth', 'borderTopWidth',
        'boxSizing', 'lineHeight', 'textTransform',
      ];
      mirror.style.position = 'absolute';
      mirror.style.visibility = 'hidden';
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.wordWrap = 'break-word';
      mirror.style.overflow = 'hidden';
      mirror.style.width = style.width;
      props.forEach((p) => { mirror.style[p] = style[p]; });

      const textBefore = el.value.substring(0, el.selectionEnd);
      mirror.textContent = textBefore;
      const span = document.createElement('span');
      span.textContent = el.value.substring(el.selectionEnd) || '.';
      mirror.appendChild(span);
      document.body.appendChild(mirror);

      const mirrorRect = mirror.getBoundingClientRect();
      const spanRect = span.getBoundingClientRect();
      document.body.removeChild(mirror);

      return {
        top: rect.top + window.scrollY + Math.min(spanRect.top - mirrorRect.top, rect.height - 10),
        left: rect.left + window.scrollX + Math.min(spanRect.left - mirrorRect.left + 10, rect.width),
      };
    }

    return { top: rect.top + window.scrollY, left: rect.right + window.scrollX };
  }

  // ── Floating Button ──

  function createFloatingBtn() {
    if (floatingBtn) return floatingBtn;

    const btn = document.createElement('button');
    btn.id = 'bgm-floating-btn';
    btn.title = 'Rewrite with Rewritely';
    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>`;

    // Use mousedown + prevent default to avoid stealing focus from the input
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onFloatingBtnClick();
    });

    document.documentElement.appendChild(btn);
    floatingBtn = btn;
    return btn;
  }

  function showFloatingBtn(coords) {
    const btn = createFloatingBtn();
    // Clamp within viewport
    const top = Math.max(4, coords.top - 40);
    const left = Math.min(coords.left + 8, window.innerWidth + window.scrollX - 44);
    btn.style.top = `${top}px`;
    btn.style.left = `${left}px`;
    btn.classList.remove('bgm-loading');
    requestAnimationFrame(() => btn.classList.add('bgm-visible'));
  }

  function hideFloatingBtn() {
    if (floatingBtn) {
      floatingBtn.classList.remove('bgm-visible');
    }
    hidePromptSelector();
  }

  // ── Prompt Selector ──

  function createPromptSelector() {
    if (promptSelector) return promptSelector;
    const el = document.createElement('div');
    el.id = 'bgm-prompt-selector';
    // Prevent focus steal
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    });
    document.documentElement.appendChild(el);
    promptSelector = el;
    return el;
  }

  function hidePromptSelector() {
    if (promptSelector) {
      promptSelector.classList.remove('bgm-visible');
    }
  }

  async function showPromptSelector() {
    if (contextDead || !isContextValid()) { handleInvalidContext(); return; }

    const selector = createPromptSelector();
    selector.innerHTML = '';

    let response;
    try {
      response = await sendRuntimeMessage({ type: 'get_prompts' });
    } catch (err) {
      handleContextError(err);
      return;
    }

    const prompts = response?.prompts || [];
    const defaultId = response?.defaultId;

    if (prompts.length === 0) {
      const item = document.createElement('button');
      item.className = 'bgm-prompt-item';
      item.textContent = 'No prompts configured';
      item.disabled = true;
      selector.appendChild(item);
    } else {
      const sorted = [...prompts].sort((a, b) => {
        if (a.id === defaultId) return -1;
        if (b.id === defaultId) return 1;
        return 0;
      });

      sorted.forEach((prompt) => {
        const item = document.createElement('button');
        item.className = 'bgm-prompt-item';
        if (prompt.id === defaultId) item.classList.add('bgm-default');
        item.textContent = prompt.title;
        item.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopImmediatePropagation();
        });
        item.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          hidePromptSelector();
          startRewrite(prompt.id);
        });
        selector.appendChild(item);
      });
    }

    if (floatingBtn) {
      const btnRect = floatingBtn.getBoundingClientRect();
      selector.style.top = `${btnRect.bottom + window.scrollY + 4}px`;
      selector.style.left = `${btnRect.left + window.scrollX}px`;
    }

    requestAnimationFrame(() => selector.classList.add('bgm-visible'));
  }

  // ── Click handler ──

  function onFloatingBtnClick() {
    if (isStreaming) return;
    showPromptSelector().catch(handleContextError);
  }

  // ── Rewrite / Streaming ──

  function startRewrite(promptId) {
    if (isStreaming || !activeElement || !selectedText) return;
    if (contextDead || !isContextValid()) { handleInvalidContext(); return; }

    isStreaming = true;
    if (floatingBtn) floatingBtn.classList.add('bgm-loading');

    // Restore selection before modifying (may have been lost to button click)
    restoreSelection(activeElement);

    // Clear the selected portion
    deleteSelectedContent(activeElement);

    // Open port to background for streaming
    let port;
    try {
      port = browserAPI.runtime.connect({ name: 'bgm-stream' });
    } catch (_) {
      handleInvalidContext();
      isStreaming = false;
      return;
    }
    currentPort = port;

    currentPort.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'stream_start':
          break;

        case 'stream_token':
          insertToken(activeElement, msg.token);
          break;

        case 'stream_end':
          finishRewrite();
          break;

        case 'error':
          handleRewriteError(msg.error);
          break;
      }
    });

    currentPort.onDisconnect.addListener(() => {
      if (isStreaming) finishRewrite();
    });

    currentPort.postMessage({
      type: 'rewrite',
      text: selectedText,
      promptId,
    });
  }

  /**
   * Delete the currently selected content from the field.
   */
  function deleteSelectedContent(el) {
    if (isNativeInput(el)) {
      const before = el.value.substring(0, selectionStart);
      const after = el.value.substring(selectionEnd);
      el.value = before + after;
      el.selectionStart = el.selectionEnd = selectionStart;
      fireInputEvent(el);
    } else {
      // contenteditable — use the saved range
      restoreSelection(el);
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        sel.getRangeAt(0).deleteContents();
      }
      fireInputEvent(el);
    }
  }

  /** Insert a token at the current cursor position (after previous token). */
  let nativeInsertPos = 0;

  function insertToken(el, token) {
    if (isNativeInput(el)) {
      // Track position via selectionStart
      const pos = el.selectionStart ?? nativeInsertPos;
      const before = el.value.substring(0, pos);
      const after = el.value.substring(pos);
      el.value = before + token + after;
      el.selectionStart = el.selectionEnd = pos + token.length;
      nativeInsertPos = pos + token.length;
      fireInputEvent(el);
    } else {
      // contenteditable — insert at current collapsed cursor
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.collapse(false);
        const textNode = document.createTextNode(token);
        range.insertNode(textNode);
        // Move cursor after inserted text
        range.setStartAfter(textNode);
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        // Fallback: just append
        el.appendChild(document.createTextNode(token));
      }
      fireInputEvent(el);
    }
  }

  function fireInputEvent(el) {
    // Standard input event
    el.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
    }));
    // Some frameworks also listen for 'change'
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function finishRewrite() {
    isStreaming = false;
    currentPort = null;
    nativeInsertPos = 0;
    savedRange = null;
    hideFloatingBtn();
  }

  function handleRewriteError(error) {
    console.error('[Rewritely]', error);
    if (activeElement) {
      insertToken(activeElement, `[Error: ${error}]`);
    }
    finishRewrite();
  }

  // ── Selection Detection ──

  function handleSelectionChange(eventTarget) {
    if (isStreaming || contextDead) return;
    if (!isContextValid()) { handleInvalidContext(); return; }

    const el = resolveEditableElement(eventTarget);
    if (!el || !isEditableElement(el)) {
      hideFloatingBtn();
      return;
    }

    const text = getSelectedText(el);
    if (!text || text.trim().length === 0) {
      hideFloatingBtn();
      return;
    }

    activeElement = el;
    selectedText = text;
    saveSelection(el);

    const coords = getCaretCoords(el);
    showFloatingBtn(coords);
  }

  // Debounce selection checks
  let selectionTimer = null;
  function debouncedSelectionCheck(eventTarget) {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => handleSelectionChange(eventTarget), 150);
  }

  // ── Event Listeners ──
  // Use CAPTURE phase so we see events before Slack/Notion/etc. can swallow them.

  document.addEventListener('mouseup', (e) => {
    if (floatingBtn?.contains(e.target) || promptSelector?.contains(e.target)) return;
    debouncedSelectionCheck(e.target);
  }, true); // ← capture

  document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'Shift') {
      debouncedSelectionCheck(e.target);
    }
  }, true); // ← capture

  // Also listen to selectionchange (fires on any selection change, very reliable)
  document.addEventListener('selectionchange', () => {
    if (isStreaming) return;
    // Only react if there's actually a selection with text
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) {
      debouncedSelectionCheck(sel.anchorNode);
    }
  });

  // Hide when clicking outside
  document.addEventListener('mousedown', (e) => {
    if (floatingBtn?.contains(e.target) || promptSelector?.contains(e.target)) return;
    hidePromptSelector();
    setTimeout(() => {
      const sel = window.getSelection();
      const el = resolveEditableElement(e.target);
      const hasText = el ? getSelectedText(el).trim().length > 0
        : (sel && sel.toString().trim().length > 0);
      if (!hasText) {
        hideFloatingBtn();
      }
    }, 200);
  }, true); // ← capture

  // ── Handle messages from background (context menu, keyboard shortcut) ──

  try { browserAPI.runtime.onMessage.addListener((msg) => {
    if (!isContextValid()) return;
    if (msg.type === 'trigger_rewrite') {
      const el = resolveEditableElement(document.activeElement);
      if (!el || !isEditableElement(el)) return;

      const text = getSelectedText(el);
      if (!text || text.trim().length === 0) return;

      activeElement = el;
      selectedText = text;
      saveSelection(el);

      startRewrite(null);
    }
  }); } catch (_) { /* context already invalidated at load time */ }

  // ── MutationObserver for SPA support ──

  const observer = new MutationObserver(() => {
    if (floatingBtn && !document.documentElement.contains(floatingBtn)) {
      floatingBtn = null;
    }
    if (promptSelector && !document.documentElement.contains(promptSelector)) {
      promptSelector = null;
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();

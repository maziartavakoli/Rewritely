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

  // Safely get browser API — works in Chrome, Firefox, and edge cases where context invalidated
  const browserAPI = (() => {
    try {
      if (typeof browser !== 'undefined' && browser?.runtime) return browser;
      if (typeof chrome !== 'undefined' && chrome?.runtime) return chrome;
    } catch(_) {}
    return null;
  })();

  if (!browserAPI) return; // Extension context not available, exit silently

  // ── Extension context check ──

  function isContextValid() {
    try {
      return !!(browserAPI && browserAPI.runtime && browserAPI.runtime.id);
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
  let pendingQuickPrompt = null;
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
          return { top: rect.bottom + 8, left: rect.right - 16 };
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
        top: rect.top + Math.min(spanRect.top - mirrorRect.top, rect.height - 10) + 8,
        left: rect.left + Math.min(spanRect.left - mirrorRect.left + 10, rect.width),
      };
    }

    return { top: rect.bottom + 8, left: rect.right - 16 };
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
    // coords may include scrollY (from getCaretCoords), convert to viewport for fixed positioning
    const viewTop  = coords.top  - (coords.hasScroll ? 0 : 0);
    const top  = Math.max(4, Math.min(viewTop,  window.innerHeight - 44));
    const left = Math.max(4, Math.min(coords.left, window.innerWidth  - 44));
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

    // ── Custom prompt input row ──
    const divider = document.createElement('div');
    divider.className = 'bgm-divider';
    selector.appendChild(divider);

    const customRow = document.createElement('div');
    customRow.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 8px;';

    const customInput = document.createElement('input');
    customInput.type = 'text';
    customInput.placeholder = 'Custom instruction…';
    customInput.style.cssText = [
      'flex:1', 'padding:6px 10px', 'border:1.5px solid #d1c4f7',
      'border-radius:6px', 'font-size:12px',
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      'color:#2d3436', 'background:#f8f6ff', 'outline:none',
      'box-sizing:border-box', 'min-width:0',
    ].join(';');
    customInput.addEventListener('mousedown', e => { e.stopImmediatePropagation(); });
    customInput.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); runCustom(); }
    });

    const runBtn = document.createElement('button');
    runBtn.textContent = '↵';
    runBtn.style.cssText = [
      'width:28px', 'height:28px', 'background:#6c5ce7', 'color:#fff',
      'border:none', 'border-radius:6px', 'font-size:14px', 'cursor:pointer',
      'display:flex', 'align-items:center', 'justify-content:center',
      'flex-shrink:0', "font-family:inherit", 'padding:0', 'box-sizing:border-box',
    ].join(';');
    runBtn.addEventListener('mousedown', e => e.preventDefault());
    runBtn.addEventListener('click', runCustom);

    function runCustom() {
      const instruction = customInput.value.trim();
      if (!instruction) return;
      hidePromptSelector();
      // Flash button red then hide
      if (floatingBtn) {
        floatingBtn.classList.add('bgm-loading');
        floatingBtn.classList.remove('bgm-visible');
        setTimeout(() => { if (floatingBtn) { floatingBtn.classList.remove('bgm-loading'); } }, 600);
      }
      // Use pendingQuickPrompt path
      pendingQuickPrompt = instruction;
      startRewrite(null);
    }

    customRow.appendChild(customInput);
    customRow.appendChild(runBtn);
    selector.appendChild(customRow);

    if (floatingBtn) {
      const btnRect  = floatingBtn.getBoundingClientRect();
      const menuW    = 380;
      const spaceBelow = window.innerHeight - btnRect.bottom - 8;
      const spaceAbove = btnRect.top - 8;

      // Flip upward if not enough space below (e.g. near bottom of screen)
      let sTop;
      if (spaceBelow >= 200 || spaceBelow >= spaceAbove) {
        sTop = btnRect.bottom + 4; // open below button
      } else {
        sTop = Math.max(4, btnRect.top - 320); // open above button
      }

      // Align with button left, clamp to viewport
      const sLeft = Math.min(Math.max(4, btnRect.left - 4), window.innerWidth - menuW - 8);

      selector.style.top       = sTop + 'px';
      selector.style.left      = sLeft + 'px';
      selector.style.maxHeight = Math.min(420, window.innerHeight - 16) + 'px';
      selector.style.overflowY = 'auto';
    }

    requestAnimationFrame(() => {
      selector.classList.add('bgm-visible');
      setTimeout(() => customInput.focus(), 80);
    });
  }

  // ── Click handler ──

  function onFloatingBtnClick() {
    if (isStreaming) return;
    showPromptSelector().catch(handleContextError);
  }

  // ── Rewrite / Streaming ──

  function startRewrite(promptId) {
    if (isStreaming || !selectedText) return;
    if (contextDead || !isContextValid()) { handleInvalidContext(); return; }

    isStreaming = true;
    if (floatingBtn) floatingBtn.classList.add('bgm-loading');

    if (activeElement) {
      // Restore selection before modifying (may have been lost to button click)
      restoreSelection(activeElement);
      // Clear the selected portion
      deleteSelectedContent(activeElement);
    }

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
          if (activeElement) {
            insertToken(activeElement, msg.token);
          } else {
            appendResultToast(msg.token);
          }
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

    if (pendingQuickPrompt) {
      const qp = pendingQuickPrompt;
      pendingQuickPrompt = null;
      currentPort.postMessage({ type: 'rewrite_quick', text: selectedText, systemPrompt: qp });
    } else {
      currentPort.postMessage({ type: 'rewrite', text: selectedText, promptId });
    }
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

  // Toast for non-editable text results
  let resultToast = null;
  let resultToastText = '';

  function appendResultToast(token) {
    resultToastText += token;

    if (!resultToast) {
      resultToast = document.createElement('div');
      resultToast.setAttribute('data-rwly-toast', '1');
      Object.assign(resultToast.style, {
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        zIndex: '2147483647',
        background: '#1e293b',
        color: 'white',
        borderRadius: '12px',
        padding: '14px 16px',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: '13px',
        lineHeight: '1.6',
        maxWidth: '380px',
        maxHeight: '240px',
        overflowY: 'auto',
        boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        whiteSpace: 'pre-wrap',
      });

      const textDiv = document.createElement('div');
      textDiv.setAttribute('data-rwly-text', '1');
      resultToast.appendChild(textDiv);

      const copyBtn = document.createElement('button');
      Object.assign(copyBtn.style, {
        display: 'block', marginTop: '10px', padding: '5px 14px',
        background: '#6c5ce7', color: 'white', border: 'none',
        borderRadius: '6px', fontSize: '12px', fontWeight: '600',
        cursor: 'pointer', fontFamily: 'inherit',
      });
      copyBtn.textContent = 'Copy';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(resultToastText).then(() => {
          copyBtn.textContent = '✓ Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 2000);
        });
      });
      resultToast.appendChild(copyBtn);
      document.documentElement.appendChild(resultToast);

      setTimeout(() => {
        document.addEventListener('mousedown', function onDown(e) {
          if (resultToast && !resultToast.contains(e.target)) {
            resultToast.remove(); resultToast = null; resultToastText = '';
            document.removeEventListener('mousedown', onDown);
          }
        });
      }, 500);
    }

    const textDiv = resultToast.querySelector('[data-rwly-text]');
    if (textDiv) { textDiv.textContent = resultToastText; resultToast.scrollTop = resultToast.scrollHeight; }
  }

  function finishRewrite() {
    isStreaming = false;
    currentPort = null;
    nativeInsertPos = 0;
    savedRange = null;
    resultToastText = '';
    resultToast = null;
    // Reset button back to purple and hide it cleanly
    if (floatingBtn) {
      floatingBtn.classList.remove('bgm-loading', 'bgm-selected', 'bgm-visible');
    }
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

    // Try editable element first
    const el = resolveEditableElement(eventTarget);
    const editableText = (el && isEditableElement(el)) ? getSelectedText(el) : '';

    // Also check window selection (works everywhere — textboxes + normal page text)
    const winSel = window.getSelection();
    const winText = winSel ? winSel.toString().trim() : '';

    const text = editableText || winText;

    if (!text || text.length === 0) {
      hideFloatingBtn();
      return;
    }

    selectedText = text;

    if (el && isEditableElement(el) && editableText) {
      // Inside an editable field — save selection so we can inject the result
      activeElement = el;
      saveSelection(el);
      const coords = getCaretCoords(el);
      showFloatingBtn(coords);
    } else {
      // Normal page text — show button at end of selection rectangle
      activeElement = null;
      if (winSel && winSel.rangeCount > 0) {
        const rect = winSel.getRangeAt(0).getBoundingClientRect();
        if (rect.width > 0 || rect.height > 0) {
          showFloatingBtn({
            top:  rect.bottom + 6,
            left: rect.right  - 16,
          });
          return;
        }
      }
      showFloatingBtn({ top: 80, left: window.innerWidth - 60 });
    }
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
    // Trigger on Shift-select AND on any key inside an editable element
    const inEditable = e.target && (
      e.target.tagName === 'TEXTAREA' ||
      (e.target.tagName === 'INPUT') ||
      e.target.isContentEditable
    );
    if (e.shiftKey || e.key === 'Shift' || inEditable) {
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

// ==UserScript==
// @name         Sub2API Account Model Checker
// @name:zh-CN   Sub2API 账号模型巡检助手
// @namespace    https://github.com/boji1334/sub2api-account-checker
// @version      2.2.0
// @description  Batch test Sub2API account model connectivity from the admin accounts page.
// @description:zh-CN  在 Sub2API 账号管理页批量测试账号模型连通性，统计成功/失败。
// @author       boji1334
// @license      MIT
// @homepageURL  https://github.com/boji1334/sub2api-account-checker
// @supportURL   https://github.com/boji1334/sub2api-account-checker/issues
// @downloadURL  https://raw.githubusercontent.com/boji1334/sub2api-account-checker/main/boji-account-tester.user.js
// @updateURL    https://raw.githubusercontent.com/boji1334/sub2api-account-checker/main/boji-account-tester.user.js
// @match        *://*/admin/accounts*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const CONFIG = {
    apiBase: location.origin,
    repoUrl: 'https://github.com/boji1334/sub2api-account-checker',
    pageSize: 100,
    defaultTimeoutMs: 10000,
    prompt: 'hi',
    defaultTestModel: 'gpt-5.5',
    pageAuthTokenKey: 'auth_token',
    authStorageKey: '__boji_account_checker_auth__',
    timeoutStorageKey: '__boji_account_checker_timeout_ms__',
    testModelStorageKey: '__boji_account_checker_test_model__',
    queryStorageKey: '__boji_account_checker_query__',
    disableStorageKey: '__boji_account_checker_disable_failed__',
    currentPageStorageKey: '__boji_account_checker_current_page_only__',
  };

  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  const state = {
    authHeader: getCachedAuthToken(),
    timeoutMs: Number(localStorage.getItem(CONFIG.timeoutStorageKey) || CONFIG.defaultTimeoutMs),
    testModel: normalizeModelId(localStorage.getItem(CONFIG.testModelStorageKey) || CONFIG.defaultTestModel),
    extraQuery: localStorage.getItem(CONFIG.queryStorageKey) || '',
    disableFailed: localStorage.getItem(CONFIG.disableStorageKey) === 'true',
    currentPageOnly: localStorage.getItem(CONFIG.currentPageStorageKey) !== 'false',
    running: false,
    stopRequested: false,
    panelReady: false,
    collapsed: false,
    failedRows: [],
    stats: {
      total: 0,
      checked: 0,
      ok: 0,
      failed: 0,
      disabled: 0,
      skipped: 0,
    },
  };

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getEmailsFromText(text) {
    return Array.from(new Set((String(text || '').match(EMAIL_RE) || []).map((email) => email.trim())));
  }

  function normalizeModelId(model) {
    const value = String(model || '').trim();
    if (!value) return '';

    const compact = value.toLowerCase().replace(/\s+/g, '-');
    const aliases = {
      'gpt-5.5': 'gpt-5.5',
      'gpt-5.4': 'gpt-5.4',
      'gpt-5.3-codex': 'gpt-5.3-codex',
      'gpt-5.3codex': 'gpt-5.3-codex',
    };

    return aliases[compact] || value;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function getCachedAuthToken() {
    const raw =
      localStorage.getItem(CONFIG.pageAuthTokenKey) ||
      sessionStorage.getItem(CONFIG.pageAuthTokenKey) ||
      localStorage.getItem(CONFIG.authStorageKey) ||
      '';
    return raw ? (raw.startsWith('Bearer ') ? raw : `Bearer ${raw}`) : '';
  }

  function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const line = `[${time}] ${message}`;
    console[type === 'error' ? 'error' : 'log'](`[boji-account-checker] ${line}`);

    const box = document.querySelector('#boji-account-checker-log');
    if (!box) return;

    const row = document.createElement('div');
    row.className = `bac-log-line ${type}`;
    row.textContent = line;
    box.appendChild(row);
    box.scrollTop = box.scrollHeight;
  }

  function saveAuth(auth) {
    if (!auth || typeof auth !== 'string') return;
    const normalized = auth.startsWith('Bearer ') ? auth : `Bearer ${auth}`;
    state.authHeader = normalized;
    localStorage.setItem(CONFIG.authStorageKey, normalized);
    const input = document.querySelector('#boji-account-checker-auth');
    if (input && !input.value) input.value = normalized;
    log('已捕获 Authorization', 'success');
  }

  function injectAuthSniffer() {
    const script = document.createElement('script');
    script.textContent = `
      (() => {
        const emit = (auth) => {
          if (!auth) return;
          document.dispatchEvent(new CustomEvent('__boji_account_checker_auth__', { detail: auth }));
        };
        const pickAuth = (headersLike) => {
          try {
            if (!headersLike) return '';
            if (headersLike instanceof Headers) {
              return headersLike.get('Authorization') || headersLike.get('authorization') || '';
            }
            if (Array.isArray(headersLike)) {
              for (const [key, value] of headersLike) {
                if (String(key).toLowerCase() === 'authorization') return value || '';
              }
              return '';
            }
            if (typeof headersLike === 'object') {
              for (const key of Object.keys(headersLike)) {
                if (key.toLowerCase() === 'authorization') return headersLike[key] || '';
              }
            }
          } catch (_) {}
          return '';
        };

        const originalFetch = window.fetch;
        if (originalFetch) {
          window.fetch = function(input, init) {
            const auth = pickAuth(init && init.headers) || pickAuth(input && input.headers);
            if (auth) emit(auth);
            return originalFetch.apply(this, arguments);
          };
        }

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function() {
          this.__bojiAccountCheckerAuth = '';
          return originalOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
          if (String(name).toLowerCase() === 'authorization' && value) {
            this.__bojiAccountCheckerAuth = value;
            emit(value);
          }
          return originalSetRequestHeader.apply(this, arguments);
        };
      })();
    `;
    document.documentElement.appendChild(script);
    script.remove();

    document.addEventListener('__boji_account_checker_auth__', (event) => {
      saveAuth(event.detail);
    });
  }

  async function waitDomReady() {
    if (document.body) return;
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (document.body) {
          clearInterval(timer);
          resolve();
        }
      }, 50);
    });
  }

  function injectStyles() {
    if (document.querySelector('#boji-account-checker-style')) return;
    const style = document.createElement('style');
    style.id = 'boji-account-checker-style';
    style.textContent = `
      #boji-account-checker-shell {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 2147483000;
        color: #e7eefc;
        font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #boji-account-checker-panel {
        width: 460px;
        max-width: calc(100vw - 36px);
        background: #101b2b;
        border: 1px solid rgba(137, 161, 194, 0.28);
        border-radius: 10px;
        box-shadow: 0 16px 54px rgba(0, 0, 0, 0.48);
        overflow: hidden;
      }
      #boji-account-checker-panel.collapsed .bac-body {
        display: none;
      }
      #boji-account-checker-panel * {
        box-sizing: border-box;
      }
      .bac-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        padding: 12px 14px;
        background: #17263a;
        border-bottom: 1px solid rgba(137, 161, 194, 0.18);
      }
      .bac-title {
        display: grid;
        gap: 2px;
      }
      .bac-title strong {
        font-size: 15px;
      }
      .bac-title span {
        color: #91a2bb;
      }
      .bac-title a {
        color: #31d6c7;
        text-decoration: none;
      }
      .bac-title a:hover {
        text-decoration: underline;
      }
      .bac-body {
        display: grid;
        gap: 10px;
        padding: 12px;
      }
      .bac-grid {
        display: grid;
        grid-template-columns: 1fr 120px;
        gap: 8px;
      }
      .bac-field {
        display: grid;
        gap: 4px;
        color: #9fb0c8;
      }
      .bac-field input,
      .bac-field textarea {
        width: 100%;
        border: 1px solid rgba(137, 161, 194, 0.28);
        border-radius: 7px;
        background: #0b1320;
        color: #e7eefc;
        padding: 8px;
        outline: none;
        font: inherit;
      }
      .bac-field textarea {
        min-height: 46px;
        resize: vertical;
      }
      .bac-row {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      .bac-check {
        display: inline-flex;
        gap: 6px;
        align-items: center;
        color: #c8d4e6;
      }
      .bac-actions {
        display: flex;
        gap: 8px;
      }
      #boji-account-checker-panel button {
        border: 1px solid rgba(137, 161, 194, 0.28);
        background: #223148;
        color: #e7eefc;
        border-radius: 7px;
        min-height: 32px;
        padding: 0 12px;
        cursor: pointer;
        font: inherit;
      }
      #boji-account-checker-panel button.primary {
        background: #12a99a;
        border-color: rgba(54, 211, 190, 0.5);
        color: #fff;
      }
      #boji-account-checker-panel button.danger {
        border-color: rgba(248, 113, 113, 0.38);
      }
      #boji-account-checker-panel button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .bac-stats {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 6px;
      }
      .bac-stat {
        min-width: 0;
        padding: 8px;
        background: #0b1320;
        border: 1px solid rgba(137, 161, 194, 0.16);
        border-radius: 7px;
      }
      .bac-stat span {
        display: block;
        color: #91a2bb;
      }
      .bac-stat strong {
        display: block;
        margin-top: 2px;
        font-size: 16px;
      }
      .bac-stat.ok strong { color: #3ee089; }
      .bac-stat.failed strong { color: #ff6b6b; }
      #boji-account-checker-log {
        height: 260px;
        overflow: auto;
        padding: 8px;
        border-radius: 8px;
        border: 1px solid rgba(137, 161, 194, 0.16);
        background: #050a12;
        white-space: pre-wrap;
      }
      .bac-log-line { color: #d9e2f2; }
      .bac-log-line.success { color: #95de64; }
      .bac-log-line.warn { color: #ffd666; }
      .bac-log-line.error { color: #ff7875; }
    `;
    document.head.appendChild(style);
  }

  function ensurePanel() {
    if (state.panelReady) return;
    state.panelReady = true;
    injectStyles();

    const shell = document.createElement('div');
    shell.id = 'boji-account-checker-shell';
    shell.innerHTML = `
      <div id="boji-account-checker-panel">
        <div class="bac-header">
          <div class="bac-title">
            <strong>账号模型巡检</strong>
            <span>API 模式，目标模型：${escapeHtml(state.testModel)}</span>
            <span><a href="${escapeHtml(CONFIG.repoUrl)}" target="_blank" rel="noopener noreferrer">GitHub: boji1334/sub2api-account-checker · 求 Star</a></span>
          </div>
          <button id="boji-account-checker-collapse">-</button>
        </div>
        <div class="bac-body">
          <label class="bac-field">
            Authorization
            <input id="boji-account-checker-auth" type="password" placeholder="Bearer xxxxxx" value="${escapeHtml(state.authHeader)}">
          </label>
          <div class="bac-grid">
            <label class="bac-field">
              测试模型
              <input id="boji-account-checker-model" type="text" value="${escapeHtml(state.testModel)}">
            </label>
            <label class="bac-field">
              超时秒数
              <input id="boji-account-checker-timeout" type="number" min="1" step="1" value="${Math.max(1, Math.round(state.timeoutMs / 1000))}">
            </label>
          </div>
          <label class="bac-field">
            额外查询参数，可留空；会覆盖地址栏同名参数。例如：subscription=plus&group=xxx
            <textarea id="boji-account-checker-query" placeholder="subscription=plus">${escapeHtml(state.extraQuery)}</textarea>
          </label>
          <div class="bac-row">
            <label class="bac-check">
              <input id="boji-account-checker-current-page" type="checkbox" ${state.currentPageOnly ? 'checked' : ''}>
              按页面滚动扫描过滤账号（备用）
            </label>
            <label class="bac-check">
              <input id="boji-account-checker-disable" type="checkbox" ${state.disableFailed ? 'checked' : ''}>
              失败自动关闭调度
            </label>
          </div>
          <div class="bac-stats">
            <div class="bac-stat"><span>总数</span><strong data-stat="total">0</strong></div>
            <div class="bac-stat"><span>已测</span><strong data-stat="checked">0</strong></div>
            <div class="bac-stat ok"><span>成功</span><strong data-stat="ok">0</strong></div>
            <div class="bac-stat failed"><span>失败</span><strong data-stat="failed">0</strong></div>
            <div class="bac-stat"><span>已关闭</span><strong data-stat="disabled">0</strong></div>
            <div class="bac-stat"><span>跳过</span><strong data-stat="skipped">0</strong></div>
          </div>
          <div class="bac-actions">
            <button class="primary" id="boji-account-checker-start">开始巡检</button>
            <button class="danger" id="boji-account-checker-stop">停止</button>
            <button id="boji-account-checker-copy">复制失败邮箱</button>
            <button id="boji-account-checker-clear">清空日志</button>
          </div>
          <div id="boji-account-checker-log"></div>
        </div>
      </div>
    `;
    document.body.appendChild(shell);

    shell.querySelector('#boji-account-checker-collapse').addEventListener('click', () => {
      state.collapsed = !state.collapsed;
      const panel = shell.querySelector('#boji-account-checker-panel');
      panel.classList.toggle('collapsed', state.collapsed);
      shell.querySelector('#boji-account-checker-collapse').textContent = state.collapsed ? '+' : '-';
    });

    shell.querySelector('#boji-account-checker-auth').addEventListener('change', (event) => {
      saveAuth(event.target.value.trim());
    });
    shell.querySelector('#boji-account-checker-model').addEventListener('change', (event) => {
      const model = event.target.value.trim();
      if (!model) return;
      state.testModel = normalizeModelId(model);
      event.target.value = state.testModel;
      localStorage.setItem(CONFIG.testModelStorageKey, state.testModel);
      log(`已设置测试模型：${state.testModel}`, 'success');
    });
    shell.querySelector('#boji-account-checker-timeout').addEventListener('change', (event) => {
      const seconds = Math.max(1, Number(event.target.value || 1));
      state.timeoutMs = seconds * 1000;
      localStorage.setItem(CONFIG.timeoutStorageKey, String(state.timeoutMs));
      log(`已设置超时：${seconds} 秒`, 'success');
    });
    shell.querySelector('#boji-account-checker-query').addEventListener('change', (event) => {
      state.extraQuery = event.target.value.trim();
      localStorage.setItem(CONFIG.queryStorageKey, state.extraQuery);
      log('已保存额外查询参数', 'success');
    });
    shell.querySelector('#boji-account-checker-disable').addEventListener('change', (event) => {
      state.disableFailed = event.target.checked;
      localStorage.setItem(CONFIG.disableStorageKey, String(state.disableFailed));
      log(state.disableFailed ? '失败账号会自动关闭调度' : '失败账号只统计，不自动关闭', state.disableFailed ? 'warn' : 'success');
    });
    shell.querySelector('#boji-account-checker-current-page').addEventListener('change', (event) => {
      state.currentPageOnly = event.target.checked;
      localStorage.setItem(CONFIG.currentPageStorageKey, String(state.currentPageOnly));
      log(state.currentPageOnly ? '将按页面扫描到的账号过滤' : '将按接口返回账号巡检', 'success');
    });
    shell.querySelector('#boji-account-checker-start').addEventListener('click', () => run().catch((error) => {
      state.running = false;
      updateStats();
      log(`运行异常：${error.message || error}`, 'error');
    }));
    shell.querySelector('#boji-account-checker-stop').addEventListener('click', () => {
      state.stopRequested = true;
      log('已请求停止，当前请求结束后退出', 'warn');
    });
    shell.querySelector('#boji-account-checker-copy').addEventListener('click', copyFailedRows);
    shell.querySelector('#boji-account-checker-clear').addEventListener('click', () => {
      const box = document.querySelector('#boji-account-checker-log');
      if (box) box.innerHTML = '';
    });

    updateStats();
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>"']/g, (char) => {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return map[char];
    });
  }

  function updateStats() {
    const root = document.querySelector('#boji-account-checker-panel');
    if (!root) return;
    for (const [key, value] of Object.entries(state.stats)) {
      const el = root.querySelector(`[data-stat="${key}"]`);
      if (el) el.textContent = String(value);
    }
  }

  function resetStats() {
    state.failedRows = [];
    state.stats = {
      total: 0,
      checked: 0,
      ok: 0,
      failed: 0,
      disabled: 0,
      skipped: 0,
    };
    updateStats();
    const box = document.querySelector('#boji-account-checker-log');
    if (box) box.innerHTML = '';
  }

  async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.authHeader && !headers.has('Authorization')) {
      headers.set('Authorization', state.authHeader);
    }
    return fetch(url, {
      ...options,
      headers,
      credentials: 'include',
    });
  }

  function applyExtraQuery(url) {
    const raw = normalizeText(state.extraQuery);
    if (!raw) return;
    const params = new URLSearchParams(raw.replace(/^\?/, ''));
    for (const [key, value] of params.entries()) {
      url.searchParams.set(key, value);
    }
  }

  function applyLocationFilters(url) {
    const allowed = new Set(['platform', 'type', 'status', 'privacy_mode', 'group', 'search']);
    const params = new URLSearchParams(location.search || '');
    for (const [key, value] of params.entries()) {
      if (allowed.has(key) && value !== '') {
        url.searchParams.set(key, value);
      }
    }
  }

  async function fetchAccounts() {
    const items = [];
    let page = 1;

    while (true) {
      const url = new URL('/api/v1/admin/accounts', CONFIG.apiBase);
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', String(CONFIG.pageSize));
      url.searchParams.set('platform', '');
      url.searchParams.set('type', '');
      url.searchParams.set('status', '');
      url.searchParams.set('privacy_mode', '');
      url.searchParams.set('group', '');
      url.searchParams.set('search', '');
      url.searchParams.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');
      applyLocationFilters(url);
      applyExtraQuery(url);

      const response = await apiFetch(url.toString(), {
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      if (!response.ok) throw new Error(`账号列表请求失败：HTTP ${response.status}`);
      const json = await response.json();
      if (json.code !== 0) throw new Error(`账号列表返回异常：${json.message || json.code}`);

      const pageItems = json?.data?.items || [];
      items.push(...pageItems);

      const pages = Number(json?.data?.pages || 1);
      if (page >= pages || !pageItems.length) break;
      page += 1;
    }

    return items;
  }

  function accountEmail(account) {
    return (
      account?.name ||
      account?.email ||
      account?.account ||
      account?.username ||
      account?.credentials?.email ||
      ''
    );
  }

  function accountTitle(account) {
    return `#${account.id} ${accountEmail(account) || account.name || '(未命名)'}`;
  }

  function isVisible(el) {
    if (!el || el.closest?.('#boji-account-checker-shell')) return false;
    const style = getComputedStyle(el);
    const opacity = style.opacity === '' ? 1 : Number(style.opacity);
    if (style.display === 'none' || style.visibility === 'hidden' || opacity === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function findAccountScrollContainer() {
    const candidates = Array.from(document.querySelectorAll('main, section, article, div, table, tbody, [role="table"], [role="grid"]'))
      .filter((el) => {
        if (!isVisible(el)) return false;
        const text = normalizeText(el.innerText || el.textContent || '');
        return el.scrollHeight > el.clientHeight + 30 && getEmailsFromText(text).length > 0;
      })
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const emailCount = getEmailsFromText(el.innerText || el.textContent || '').length;
        return { el, score: emailCount * 100000 - rect.width * rect.height };
      })
      .sort((a, b) => b.score - a.score);

    return candidates[0]?.el || document.scrollingElement || document.documentElement;
  }

  function getScrollTop(el) {
    if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
      return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }
    return el.scrollTop;
  }

  function setScrollTop(el, value) {
    if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
      window.scrollTo({ top: value, behavior: 'instant' });
      document.documentElement.scrollTop = value;
      document.body.scrollTop = value;
      return;
    }
    el.scrollTop = value;
  }

  function getMaxScrollTop(el) {
    if (el === document.scrollingElement || el === document.documentElement || el === document.body) {
      return Math.max(0, document.documentElement.scrollHeight - innerHeight);
    }
    return Math.max(0, el.scrollHeight - el.clientHeight);
  }

  async function scanCurrentPageEmails() {
    const scroller = findAccountScrollContainer();
    const originalTop = getScrollTop(scroller);
    const max = getMaxScrollTop(scroller);
    const step = Math.max(140, Math.floor((scroller.clientHeight || innerHeight) * 0.55));
    const emails = [];
    const seenRows = new Set();

    const collect = () => {
      for (const el of Array.from(document.querySelectorAll('td, div, span, p, a'))) {
        if (!isVisible(el)) continue;
        const text = normalizeText(el.innerText || el.textContent || '');
        const found = getEmailsFromText(text);
        if (!found.length) continue;
        for (const email of found) {
          const row = findLikelyRow(el, email);
          const rowText = normalizeText(row?.innerText || row?.textContent || text);
          const key = `${email}::${rowText.slice(0, 180)}`;
          if (seenRows.has(key)) continue;
          seenRows.add(key);
          emails.push(email);
        }
      }
    };

    setScrollTop(scroller, 0);
    await sleep(120);
    collect();

    for (let pos = 0; pos <= max + step; pos += step) {
      if (state.stopRequested) break;
      setScrollTop(scroller, Math.min(pos, max));
      scroller.dispatchEvent?.(new Event('scroll', { bubbles: true }));
      await sleep(160);
      collect();
    }

    setScrollTop(scroller, originalTop);
    return emails;
  }

  function findLikelyRow(emailEl, email) {
    let current = emailEl;
    const candidates = [];
    while (current && current !== document.body) {
      const text = normalizeText(current.innerText || current.textContent || '');
      const rect = current.getBoundingClientRect();
      if (text.includes(email) && rect.width > 360 && rect.height >= 28 && rect.height < Math.max(260, innerHeight * 0.4)) {
        candidates.push(current);
      }
      current = current.parentElement;
    }
    return candidates.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0] || emailEl;
  }

  async function filterAccountsByCurrentPage(accounts) {
    if (!state.currentPageOnly) return accounts;

    log('正在滚动扫描当前页面账号邮箱');
    const emails = await scanCurrentPageEmails();
    if (!emails.length) {
      log('当前页面没有扫描到邮箱，将回退为检测接口返回的全部账号', 'warn');
      return accounts;
    }

    const counts = new Map();
    for (const email of emails) counts.set(email.toLowerCase(), (counts.get(email.toLowerCase()) || 0) + 1);

    const selected = [];
    for (const account of accounts) {
      const email = accountEmail(account).toLowerCase();
      const left = counts.get(email) || 0;
      if (left <= 0) continue;
      selected.push(account);
      counts.set(email, left - 1);
    }

    log(`当前页面扫描到 ${emails.length} 行，匹配接口账号 ${selected.length} 个`, selected.length ? 'success' : 'warn');
    return selected.length ? selected : accounts;
  }

  async function ensureAuth() {
    const cached = getCachedAuthToken();
    if (cached) {
      saveAuth(cached);
      return true;
    }
    if (state.authHeader) return true;
    const fromInput = document.querySelector('#boji-account-checker-auth')?.value?.trim();
    if (fromInput) {
      saveAuth(fromInput);
      return true;
    }
    const manual = prompt('没有自动捕获到 Authorization，请粘贴 Bearer token');
    if (!manual) return false;
    saveAuth(manual.trim());
    return true;
  }

  async function testModel(accountId, modelId) {
    const normalizedModelId = normalizeModelId(modelId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), state.timeoutMs);

    try {
      const response = await apiFetch(`${CONFIG.apiBase}/api/v1/admin/accounts/${accountId}/test`, {
        method: 'POST',
        headers: {
          Accept: '*/*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model_id: normalizedModelId, prompt: CONFIG.prompt }),
        signal: controller.signal,
      });

      if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        return { ok: false, reason: `无响应流：${text.slice(0, 160)}` };
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

        let splitIndex;
        while ((splitIndex = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, splitIndex);
          buffer = buffer.slice(splitIndex + 2);
          const dataLines = chunk
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim());

          for (const line of dataLines) {
            if (!line) continue;
            let event;
            try {
              event = JSON.parse(line);
            } catch (_) {
              continue;
            }
            if (event.type === 'error') return { ok: false, reason: event.error || '未知错误' };
            if (event.type === 'test_complete') return { ok: !!event.success, reason: event.success ? 'success' : 'test_complete=false' };
          }
        }
      }

      return { ok: false, reason: '响应流结束但没有 test_complete' };
    } catch (error) {
      return { ok: false, reason: error?.name === 'AbortError' ? '请求超时' : error?.message || String(error) };
    } finally {
      clearTimeout(timer);
    }
  }

  async function setAccountSchedulable(accountId, schedulable) {
    const response = await apiFetch(`${CONFIG.apiBase}/api/v1/admin/accounts/${accountId}/schedulable`, {
      method: 'POST',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ schedulable: !!schedulable }),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    const json = await response.json();
    if (json.code !== 0) return { ok: false, reason: json.message || `code=${json.code}` };
    return { ok: true };
  }

  async function copyFailedRows() {
    const text = state.failedRows.map((row) => `${row.email}\t${row.reason}`).join('\n');
    if (!text) {
      log('当前没有失败记录可复制', 'warn');
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    log(`已复制 ${state.failedRows.length} 条失败记录`, 'success');
  }

  async function run() {
    if (state.running) {
      log('已有任务在运行', 'warn');
      return;
    }
    if (!(await ensureAuth())) {
      log('缺少 Authorization，已取消', 'error');
      return;
    }

    state.running = true;
    state.stopRequested = false;
    resetStats();

    try {
      log('开始拉取账号列表');
      let accounts = await fetchAccounts();
      log(`接口返回 ${accounts.length} 个账号`, 'success');

      accounts = await filterAccountsByCurrentPage(accounts);
      state.stats.total = accounts.length;
      updateStats();

      for (const account of accounts) {
        if (state.stopRequested) break;

        const title = accountTitle(account);
        const email = accountEmail(account);
        const model = state.testModel;

        log(`${title} 开始测试 ${model}`);
        const result = await testModel(account.id, model);
        state.stats.checked += 1;

        if (result.ok) {
          state.stats.ok += 1;
          log(`${title} ${model} 正常`, 'success');
        } else {
          state.stats.failed += 1;
          state.failedRows.push({ id: account.id, email, reason: result.reason });
          log(`${title} ${model} 异常：${result.reason}`, 'error');

          if (state.disableFailed) {
            const off = await setAccountSchedulable(account.id, false);
            if (off.ok) {
              state.stats.disabled += 1;
              log(`${title} 已关闭调度`, 'success');
            } else {
              log(`${title} 关闭调度失败：${off.reason}`, 'error');
            }
          }
        }

        updateStats();
      }

      log(state.stopRequested ? '任务已停止' : '巡检完成', state.stopRequested ? 'warn' : 'success');
    } finally {
      state.running = false;
      updateStats();
    }
  }

  if (globalThis.__BOJI_ACCOUNT_CHECKER_TEST_MODE__) {
    globalThis.__BOJI_ACCOUNT_CHECKER_TEST_HOOK__?.({
      CONFIG,
      state,
      fetchAccounts,
      testModel,
      setAccountSchedulable,
      accountEmail,
      accountTitle,
    });
    return;
  }

  injectAuthSniffer();
  waitDomReady().then(() => {
    ensurePanel();
    if (state.authHeader) {
      log('脚本已就绪，已读取 Authorization', 'success');
    } else {
      log('脚本已就绪；若没有自动捕获 Authorization，请刷新页面或手动粘贴');
    }
  });
})();

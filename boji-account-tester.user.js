// ==UserScript==
// @name         Sub2API Account Model Checker
// @name:zh-CN   Sub2API 账号模型巡检助手
// @namespace    https://github.com/boji1334/sub2api-account-checker
// @version      2.4.1
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
    selectedGroupStorageKey: '__boji_account_checker_selected_group__',
    disableStorageKey: '__boji_account_checker_disable_failed__',
  };

  const ACCOUNT_FILTER_EXCLUDE_KEYS = new Set(['page', 'page_size', 'timezone']);
  const ACCOUNT_DEFAULT_FILTER_KEYS = ['platform', 'type', 'status', 'privacy_mode', 'group', 'search', 'subscription'];

  const state = {
    authHeader: getCachedAuthToken(),
    timeoutMs: Number(localStorage.getItem(CONFIG.timeoutStorageKey) || CONFIG.defaultTimeoutMs),
    testModel: normalizeModelId(localStorage.getItem(CONFIG.testModelStorageKey) || CONFIG.defaultTestModel),
    accountFilters: getLocationAccountFilters(),
    groups: [],
    selectedGroupKey: localStorage.getItem(CONFIG.selectedGroupStorageKey) || '',
    lastAppliedFilters: null,
    disableFailed: localStorage.getItem(CONFIG.disableStorageKey) === 'true',
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

  function normalizeAccountFilters(filters = {}) {
    const next = {};
    for (const key of ACCOUNT_DEFAULT_FILTER_KEYS) next[key] = '';
    for (const [key, value] of Object.entries(filters || {})) {
      if (ACCOUNT_FILTER_EXCLUDE_KEYS.has(key)) continue;
      next[key] = String(value ?? '');
    }
    return next;
  }

  function groupKey(group) {
    if (!group) return '';
    if (group.id !== undefined && group.id !== null && group.id !== '') return `id:${group.id}`;
    if (group.name) return `name:${String(group.name).toLowerCase()}`;
    return '';
  }

  function normalizeGroupOption(group) {
    if (!group || typeof group !== 'object') return null;
    const name = String(group.name || group.title || group.label || group.group || group.subscription || '').trim();
    const id = group.id ?? group.group_id ?? group.groupId ?? '';
    const platform = String(group.platform || group.type || '').trim();
    if (!name && (id === '' || id === null || id === undefined)) return null;
    const normalized = {
      id,
      name: name || String(id),
      platform,
      raw: group,
    };
    normalized.key = groupKey(normalized);
    return normalized.key ? normalized : null;
  }

  function normalizeGroupOptions(groups) {
    const seen = new Set();
    const result = [];
    for (const group of Array.isArray(groups) ? groups : []) {
      const option = normalizeGroupOption(group);
      if (!option || seen.has(option.key)) continue;
      seen.add(option.key);
      result.push(option);
    }
    return result.sort((a, b) => {
      const platformScore = (item) => (!item.platform || item.platform === 'openai' ? 0 : 1);
      return platformScore(a) - platformScore(b) || a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
  }

  function mergeGroups(groups) {
    const seen = new Set();
    const merged = [];
    for (const group of [...state.groups, ...normalizeGroupOptions(groups)]) {
      if (!group || seen.has(group.key)) continue;
      seen.add(group.key);
      merged.push(group);
    }
    state.groups = merged;
    renderGroupOptions();
  }

  function collectGroupsFromAccounts(accounts) {
    const groups = [];
    for (const account of Array.isArray(accounts) ? accounts : []) {
      for (const rawGroup of getAccountGroupValues(account)) {
        if (rawGroup && typeof rawGroup === 'object') {
          groups.push(rawGroup);
        } else if (String(rawGroup || '').trim()) {
          groups.push({ name: String(rawGroup).trim(), platform: account?.platform || account?.type || '' });
        }
      }
    }
    return normalizeGroupOptions(groups);
  }

  function getAccountGroupValues(account) {
    const values = [
      account?.group,
      account?.group_name,
      account?.groupName,
      account?.group_id,
      account?.groupId,
      account?.subscription,
      account?.subscription_name,
      account?.subscriptionName,
    ];
    const groups = account?.groups || account?.subscriptions;
    if (Array.isArray(groups)) values.push(...groups);
    return values.filter((value) => value !== undefined && value !== null && value !== '');
  }

  function groupValueMatches(value, selectedGroup) {
    if (!selectedGroup) return true;
    if (value && typeof value === 'object') {
      return groupValueMatches(value.id ?? value.group_id ?? value.groupId ?? '', selectedGroup) ||
        groupValueMatches(value.name ?? value.title ?? value.label ?? value.group ?? value.subscription ?? '', selectedGroup);
    }

    const actual = String(value || '').trim().toLowerCase();
    if (!actual) return false;
    const expectedNames = new Set([
      String(selectedGroup.name || '').trim().toLowerCase(),
      String(selectedGroup.id ?? '').trim().toLowerCase(),
    ].filter(Boolean));
    return expectedNames.has(actual);
  }

  function filterAccountsBySelectedGroup(accounts) {
    const selectedGroup = getSelectedGroup();
    if (!selectedGroup) return accounts;
    return (Array.isArray(accounts) ? accounts : []).filter((account) =>
      getAccountGroupValues(account).some((value) => groupValueMatches(value, selectedGroup))
    );
  }

  function getSelectedGroup() {
    if (!state.selectedGroupKey) return null;
    return state.groups.find((group) => group.key === state.selectedGroupKey) || null;
  }

  function getLocationAccountFilters() {
    const filters = {};
    const params = new URLSearchParams(location.search || '');
    for (const [key, value] of params.entries()) {
      if (!ACCOUNT_FILTER_EXCLUDE_KEYS.has(key)) filters[key] = value;
    }
    return normalizeAccountFilters(filters);
  }

  function normalizePath(path) {
    let value = String(path || '');
    while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
    return value;
  }

  function getAccountFiltersFromUrl(urlLike) {
    try {
      const rawUrl = typeof urlLike === 'string' ? urlLike : urlLike?.url || String(urlLike || '');
      const url = new URL(rawUrl, location.origin);
      if (url.origin !== location.origin || normalizePath(url.pathname) !== '/api/v1/admin/accounts') return null;

      const filters = {};
      for (const [key, value] of url.searchParams.entries()) {
        if (!ACCOUNT_FILTER_EXCLUDE_KEYS.has(key)) filters[key] = value;
      }
      return normalizeAccountFilters(filters);
    } catch (_) {
      return null;
    }
  }

  function accountFilterSummary(filters = state.accountFilters) {
    const visible = Object.entries(filters || {})
      .filter(([key, value]) => !ACCOUNT_FILTER_EXCLUDE_KEYS.has(key) && String(value || '') !== '')
      .map(([key, value]) => `${key}=${value}`);
    return visible.length ? visible.join('&') : '全部账号';
  }

  function getEffectiveAccountFilters() {
    const filters = normalizeAccountFilters(state.accountFilters);
    const selectedGroup = getSelectedGroup();
    if (!selectedGroup) return filters;

    filters.group = selectedGroup.name || String(selectedGroup.id || '');
    filters.subscription = '';
    return filters;
  }

  function buildSelectedGroupFilterCandidates() {
    const selectedGroup = getSelectedGroup();
    if (!selectedGroup) return [getEffectiveAccountFilters()];

    const base = normalizeAccountFilters(state.accountFilters);
    const candidates = [];
    const add = (key, value) => {
      const clean = String(value ?? '').trim();
      if (!clean) return;
      const filters = normalizeAccountFilters(base);
      filters.group = '';
      filters.subscription = '';
      filters[key] = clean;
      const signature = accountFilterSummary(filters);
      if (candidates.some((item) => item.signature === signature)) return;
      candidates.push({ filters, signature });
    };

    add('group', selectedGroup.name);
    add('group', selectedGroup.id);
    add('subscription', selectedGroup.name);
    add('subscription', selectedGroup.id);

    return candidates.length ? candidates.map((item) => item.filters) : [base];
  }

  function effectiveFilterSummary() {
    const selectedGroup = getSelectedGroup();
    if (selectedGroup) return `分组=${selectedGroup.name}`;
    return accountFilterSummary(getEffectiveAccountFilters());
  }

  function updateFilterHint() {
    if (typeof document === 'undefined') return;
    const el = document.querySelector('#boji-account-checker-filter');
    if (el) el.textContent = `当前筛选：${effectiveFilterSummary()}`;
  }

  function rememberAccountFilters(filters) {
    if (state.selectedGroupKey) return;
    const next = normalizeAccountFilters(filters);
    const oldSummary = accountFilterSummary(state.accountFilters);
    const nextSummary = accountFilterSummary(next);
    state.accountFilters = next;
    updateFilterHint();
    if (oldSummary !== nextSummary && typeof document !== 'undefined' && document.querySelector('#boji-account-checker-log')) {
      log(`已同步页面筛选：${nextSummary}`, 'success');
    }
  }

  function renderGroupOptions() {
    if (typeof document === 'undefined') return;
    const select = document.querySelector('#boji-account-checker-group');
    if (!select) return;

    const current = state.selectedGroupKey;
    select.innerHTML = '';
    select.appendChild(new Option('全部分组', ''));
    for (const group of state.groups) {
      const label = group.platform && group.platform !== 'openai' ? `${group.name} (${group.platform})` : group.name;
      select.appendChild(new Option(label, group.key));
    }

    if (current && state.groups.some((group) => group.key === current)) {
      select.value = current;
    } else {
      state.selectedGroupKey = '';
      select.value = '';
      localStorage.removeItem(CONFIG.selectedGroupStorageKey);
    }
    updateFilterHint();
  }

  async function fetchGroups() {
    const response = await apiFetch(`${CONFIG.apiBase}/api/v1/admin/groups/all`, {
      headers: { Accept: 'application/json, text/plain, */*' },
    });
    if (!response.ok) throw new Error(`分组列表请求失败：HTTP ${response.status}`);
    const json = await response.json();
    if (json.code !== 0) throw new Error(`分组列表返回异常：${json.message || json.code}`);
    return normalizeGroupOptions(json?.data || []);
  }

  async function refreshGroups() {
    try {
      const groups = await fetchGroups();
      if (groups.length) {
        state.groups = groups;
        renderGroupOptions();
        return groups;
      }
      log('分组接口返回为空，将继续使用账号列表筛选', 'warn');
      return [];
    } catch (error) {
      log(`分组加载失败：${error.message || error}`, 'warn');
      return [];
    }
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

    if (typeof document === 'undefined') return;
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
        const emitAccountFilters = (urlLike) => {
          try {
            const rawUrl = typeof urlLike === 'string' ? urlLike : (urlLike && urlLike.url) || String(urlLike || '');
            const url = new URL(rawUrl, location.origin);
            let path = String(url.pathname || '');
            while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
            if (url.origin !== location.origin || path !== '/api/v1/admin/accounts') return;

            const filters = {};
            for (const [key, value] of url.searchParams.entries()) {
              if (key === 'page' || key === 'page_size' || key === 'timezone') continue;
              filters[key] = value;
            }
            document.dispatchEvent(new CustomEvent('__boji_account_checker_account_filters__', { detail: filters }));
          } catch (_) {}
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
            emitAccountFilters(input);
            return originalFetch.apply(this, arguments);
          };
        }

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
        XMLHttpRequest.prototype.open = function(method, url) {
          this.__bojiAccountCheckerAuth = '';
          emitAccountFilters(url);
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
    document.addEventListener('__boji_account_checker_account_filters__', (event) => {
      rememberAccountFilters(event.detail);
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
        z-index: 1000;
        color: #e7eefc;
        font: 12px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      }
      #boji-account-checker-panel {
        width: 380px;
        max-width: calc(100vw - 36px);
        background: #101b2b;
        border: 1px solid rgba(137, 161, 194, 0.28);
        border-radius: 10px;
        box-shadow: 0 16px 54px rgba(0, 0, 0, 0.48);
        overflow: hidden;
        max-height: min(720px, calc(100vh - 220px));
        display: flex;
        flex-direction: column;
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
        overflow: auto;
      }
      .bac-grid {
        display: grid;
        grid-template-columns: 1fr 120px;
        gap: 8px;
      }
      .bac-group-grid {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: end;
      }
      .bac-field {
        display: grid;
        gap: 4px;
        color: #9fb0c8;
      }
      .bac-field input,
      .bac-field select,
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
      .bac-field select {
        min-height: 34px;
        appearance: auto;
      }
      .bac-field textarea {
        min-height: 46px;
        resize: vertical;
      }
      .bac-filter {
        color: #b8c7db;
        border: 1px solid rgba(137, 161, 194, 0.16);
        border-radius: 7px;
        background: rgba(11, 19, 32, 0.78);
        padding: 8px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
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
        height: 180px;
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
          <div class="bac-group-grid">
            <label class="bac-field">
              巡检分组
              <select id="boji-account-checker-group">
                <option value="">全部分组</option>
              </select>
            </label>
            <button id="boji-account-checker-refresh-groups" title="刷新分组">刷新</button>
          </div>
          <div id="boji-account-checker-filter" class="bac-filter">当前筛选：${escapeHtml(accountFilterSummary())}</div>
          <div class="bac-row">
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
    shell.querySelector('#boji-account-checker-group').addEventListener('change', (event) => {
      state.selectedGroupKey = event.target.value;
      if (state.selectedGroupKey) {
        localStorage.setItem(CONFIG.selectedGroupStorageKey, state.selectedGroupKey);
      } else {
        localStorage.removeItem(CONFIG.selectedGroupStorageKey);
      }
      updateFilterHint();
      log(`已选择巡检范围：${effectiveFilterSummary()}`, 'success');
    });
    shell.querySelector('#boji-account-checker-refresh-groups').addEventListener('click', () => {
      refreshGroups().then((groups) => {
        log(groups.length ? `已刷新 ${groups.length} 个分组` : '没有读取到分组', groups.length ? 'success' : 'warn');
      });
    });
    shell.querySelector('#boji-account-checker-disable').addEventListener('change', (event) => {
      state.disableFailed = event.target.checked;
      localStorage.setItem(CONFIG.disableStorageKey, String(state.disableFailed));
      log(state.disableFailed ? '失败账号会自动关闭调度' : '失败账号只统计，不自动关闭', state.disableFailed ? 'warn' : 'success');
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

  function applyAccountFilters(url, filters = getEffectiveAccountFilters()) {
    for (const key of ACCOUNT_DEFAULT_FILTER_KEYS) {
      url.searchParams.set(key, '');
    }
    for (const [key, value] of Object.entries(normalizeAccountFilters(filters))) {
      if (ACCOUNT_FILTER_EXCLUDE_KEYS.has(key)) continue;
      url.searchParams.set(key, value);
    }
  }

  async function fetchAccountsWithFilters(filters) {
    const items = [];
    const seenIds = new Set();
    let page = 1;

    while (true) {
      const url = new URL('/api/v1/admin/accounts', CONFIG.apiBase);
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', String(CONFIG.pageSize));
      applyAccountFilters(url, filters);
      url.searchParams.set('timezone', Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai');

      const response = await apiFetch(url.toString(), {
        headers: { Accept: 'application/json, text/plain, */*' },
      });
      if (!response.ok) {
        return {
          ok: false,
          accounts: items,
          filters,
          reason: `HTTP ${response.status}`,
        };
      }
      const json = await response.json();
      if (json.code !== 0) {
        return {
          ok: false,
          accounts: items,
          filters,
          reason: json.message || `code=${json.code}`,
        };
      }

      const pageItems = Array.isArray(json?.data?.items) ? json.data.items : [];
      const pageGroups = collectGroupsFromAccounts(pageItems);
      if (pageGroups.length) mergeGroups(pageGroups);
      for (const item of pageItems) {
        const key = item?.id == null ? `${page}:${items.length}` : String(item.id);
        if (seenIds.has(key)) continue;
        seenIds.add(key);
        items.push(item);
      }

      const pages = Number(json?.data?.pages || json?.data?.total_pages || 0);
      const total = Number(json?.data?.total || json?.data?.count || 0);
      const hasExplicitNext = typeof json?.data?.has_next === 'boolean' ? json.data.has_next : null;
      const reachedKnownTotal = total > 0 && items.length >= total;
      const reachedKnownPages = pages > 0 && page >= pages;
      const shortPage = pageItems.length < CONFIG.pageSize;
      if (!pageItems.length || hasExplicitNext === false || reachedKnownTotal || reachedKnownPages || (pages <= 0 && shortPage)) break;
      page += 1;
    }

    return { ok: true, accounts: items, filters };
  }

  async function fetchAccounts() {
    const candidates = buildSelectedGroupFilterCandidates();
    let lastFailure = '';

    for (const filters of candidates) {
      const result = await fetchAccountsWithFilters(filters);
      if (!result.ok) {
        lastFailure = `${accountFilterSummary(filters)}：${result.reason}`;
        if (getSelectedGroup()) continue;
        throw new Error(`账号列表请求失败：${result.reason}`);
      }

      const accounts = result.accounts;
      if (!getSelectedGroup()) {
        state.lastAppliedFilters = filters;
        return accounts;
      }
      if (accounts.length) {
        state.lastAppliedFilters = filters;
        if (candidates.length > 1) {
          log(`已匹配筛选参数：${accountFilterSummary(filters)}`, 'success');
        }
        return accounts;
      }
    }

    const selectedGroup = getSelectedGroup();
    if (selectedGroup) {
      const baseFilters = normalizeAccountFilters(state.accountFilters);
      baseFilters.group = '';
      baseFilters.subscription = '';
      const result = await fetchAccountsWithFilters(baseFilters);
      if (!result.ok) {
        throw new Error(`账号列表请求失败：${result.reason}${lastFailure ? `；最后一次分组筛选：${lastFailure}` : ''}`);
      }

      const filtered = filterAccountsBySelectedGroup(result.accounts);
      state.lastAppliedFilters = baseFilters;
      if (filtered.length) {
        const fallbackReason = lastFailure ? '接口分组筛选不可用，' : '';
        log(`${fallbackReason}已自动按账号字段匹配分组：${selectedGroup.name}，命中 ${filtered.length} 个`, 'success');
        return filtered;
      }

      throw new Error(`已拉取 ${result.accounts.length} 个账号，但没有账号字段匹配分组：${selectedGroup.name}`);
    }

    return [];
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
    updateFilterHint();

    try {
      log(`开始拉取账号列表（${effectiveFilterSummary()}）`);
      const accounts = await fetchAccounts();
      log(`接口返回 ${accounts.length} 个账号`, 'success');

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
      fetchGroups,
      refreshGroups,
      normalizeGroupOptions,
      rememberAccountFilters,
      getAccountFiltersFromUrl,
      accountFilterSummary,
      effectiveFilterSummary,
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
    refreshGroups();
    if (state.authHeader) {
      log('脚本已就绪，已读取 Authorization', 'success');
    } else {
      log('脚本已就绪；若没有自动捕获 Authorization，请刷新页面或手动粘贴');
    }
  });
})();

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const scriptPath = path.resolve(__dirname, '..', 'boji-account-tester.user.js');
const script = fs.readFileSync(scriptPath, 'utf8');

function createStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
    clear() {
      data.clear();
    },
  };
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return data;
    },
    async text() {
      return JSON.stringify(data);
    },
  };
}

function sseResponse(events) {
  const chunks = events.map((event) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: chunks[index++] };
          },
        };
      },
    },
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

(async () => {
  const requests = [];
  let capturedApi = null;

  const context = {
    console,
    URL,
    URLSearchParams,
    Headers,
    TextDecoder,
    TextEncoder,
    AbortController,
    setTimeout,
    clearTimeout,
    Intl,
    location: {
      origin: 'https://cat.api.boji1334.com',
      search: '?status=active',
    },
    localStorage: createStorage({
      auth_token: 'token-123',
      __boji_account_checker_test_model__: 'GPT-5.5',
    }),
    sessionStorage: createStorage(),
    __BOJI_ACCOUNT_CHECKER_TEST_MODE__: true,
    __BOJI_ACCOUNT_CHECKER_TEST_HOOK__(api) {
      capturedApi = api;
    },
    async fetch(url, options = {}) {
      const parsed = new URL(String(url));
      const headers = options.headers;
      requests.push({
        path: parsed.pathname,
        search: parsed.search,
        method: options.method || 'GET',
        auth: headers?.get?.('Authorization') || '',
        body: options.body ? JSON.parse(options.body) : null,
      });

      assert.strictEqual(headers?.get?.('Authorization'), 'Bearer token-123', 'Authorization should be attached');

      if (parsed.pathname === '/api/v1/admin/accounts') {
        assert.strictEqual(parsed.searchParams.get('subscription'), 'VIP', 'subscription should follow captured page filters');
        assert.strictEqual(parsed.searchParams.get('status'), 'active', 'status should follow URL filters');
        const page = Number(parsed.searchParams.get('page') || 1);
        const pages = {
          1: [
            { id: 1, name: 'ok@example.com', schedulable: true },
            { id: 2, name: 'bad@example.com', schedulable: true },
          ],
          2: [{ id: 3, email: 'late@example.com', schedulable: true }],
        };
        return jsonResponse({ code: 0, data: { items: pages[page] || [], pages: 2 } });
      }

      const testMatch = parsed.pathname.match(/^\/api\/v1\/admin\/accounts\/(\d+)\/test$/);
      if (testMatch) {
        assert.strictEqual(options.method, 'POST');
        assert.deepStrictEqual(JSON.parse(options.body), { model_id: 'gpt-5.5', prompt: 'hi' });
        const id = Number(testMatch[1]);
        if (id === 2) {
          return sseResponse([{ type: 'error', error: 'mock failure' }]);
        }
        return sseResponse([{ type: 'test_complete', success: true }]);
      }

      const schedulableMatch = parsed.pathname.match(/^\/api\/v1\/admin\/accounts\/(\d+)\/schedulable$/);
      if (schedulableMatch) {
        assert.strictEqual(options.method, 'POST');
        assert.deepStrictEqual(JSON.parse(options.body), { schedulable: false });
        return jsonResponse({ code: 0, data: {} });
      }

      throw new Error(`unexpected request: ${parsed.pathname}`);
    },
  };

  vm.createContext(context);
  vm.runInContext(script, context, { filename: scriptPath });

  assert(capturedApi, 'test hook should expose API functions');
  assert.strictEqual(capturedApi.state.testModel, 'gpt-5.5');
  assert.strictEqual(capturedApi.state.currentPageOnly, undefined, 'page scan filter should be removed');
  assert.strictEqual(capturedApi.accountFilterSummary(), 'status=active');
  assert.deepStrictEqual(
    plain(capturedApi.getAccountFiltersFromUrl('/api/v1/admin/accounts?page=1&page_size=10&status=active&subscription=VIP')),
    {
      platform: '',
      type: '',
      status: 'active',
      privacy_mode: '',
      group: '',
      search: '',
      subscription: 'VIP',
    },
    'account list URL filters should be parsed without pagination keys'
  );

  capturedApi.rememberAccountFilters({ status: 'active', subscription: 'VIP' });
  assert.strictEqual(capturedApi.accountFilterSummary(), 'status=active&subscription=VIP');

  const accounts = await capturedApi.fetchAccounts();
  assert.deepStrictEqual(
    Array.from(accounts, (account) => String(capturedApi.accountEmail(account))),
    ['ok@example.com', 'bad@example.com', 'late@example.com'],
    'fetchAccounts should collect all pages'
  );

  assert.deepStrictEqual(plain(await capturedApi.testModel(1, 'GPT-5.5')), { ok: true, reason: 'success' });
  assert.deepStrictEqual(plain(await capturedApi.testModel(2, 'GPT-5.5')), { ok: false, reason: 'mock failure' });
  assert.deepStrictEqual(plain(await capturedApi.setAccountSchedulable(2, false)), { ok: true });

  assert.strictEqual(requests.filter((request) => request.path === '/api/v1/admin/accounts').length, 2);
  assert(requests.some((request) => request.path.endsWith('/2/schedulable') && request.body.schedulable === false));

  console.log('boji-account-tester API selftest passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

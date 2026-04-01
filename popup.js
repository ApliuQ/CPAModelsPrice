'use strict';

/**
 * popup.js
 * 插件弹出窗口的交互逻辑。
 * 通过 chrome.scripting.executeScript 向当前活动标签页注入 content.js 中的函数，
 * 并将用户输入的参数传递过去，再将执行结果回显到弹出窗口。
 */

// ---- 工具函数 ----

/**
 * 获取当前活动标签页的 ID。
 * @returns {Promise<number>} 标签页 ID
 */
async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('无法获取当前标签页');
  return tab.id;
}

/**
 * 向标签页注入并执行指定函数。
 * @param {number} tabId - 标签页 ID
 * @param {Function} func - 要注入执行的函数
 * @param {Array} args - 传递给函数的参数列表
 * @returns {Promise<*>} 函数返回值
 */
async function runInTab(tabId, func, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  const result = results?.[0];
  if (result?.error) throw new Error(result.error.message || '页面脚本执行出错');
  return result?.result;
}

// ---- 状态显示 ----

/**
 * 更新状态文本元素的内容和样式。
 * @param {HTMLElement} el - 状态文本元素
 * @param {string} msg - 消息内容
 * @param {'info'|'success'|'error'} type - 样式类型
 */
function setStatus(el, msg, type = 'info') {
  el.textContent = msg;
  el.className = `status ${type}`;
}

// ---- 页面内注入函数（序列化后注入，不可引用外部变量）----

/**
 * 清除本地存储中的价格数据。
 * 此函数在页面上下文中执行，可直接访问 localStorage。
 * @returns {{ ok: boolean, message: string }}
 */
function pageClearPrices() {
  const STORAGE_KEY = 'cli-proxy-model-prices-v2';
  if (localStorage.getItem(STORAGE_KEY)) {
    localStorage.removeItem(STORAGE_KEY);
    return { ok: true, message: '价格数据已清除，页面即将刷新。' };
  }
  return { ok: false, message: '未发现已存储的价格数据，无需清除。' };
}

/**
 * 同步模型价格到本地存储。
 * 此函数在页面上下文中执行，可直接访问 localStorage 和 fetch。
 * @param {string} filterText - 关键词筛选文本
 * @param {string} manualKey - 手动输入的管理密钥（可为空）
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function pageSyncPrices(filterText, manualKey) {
  // ---- 常量 ----
  const STORAGE_KEYS = {
    prices: 'cli-proxy-model-prices-v2',
    auth: 'cli-proxy-auth',
    lastFilter: 'cli-proxy-model-prices-last-filter',
  };
  const PRICING_URL = 'https://models.dev/api.json';
  const REQUEST_TIMEOUT_MS = 15000;
  const SECURE_STORAGE_PREFIX = 'enc::v1::';
  const SECURE_STORAGE_NAMESPACE = 'cli-proxy-api-webui::secure-storage';

  // ---- 工具函数 ----
  function getItem(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  }
  function setItem(key, value) {
    try { localStorage.setItem(key, value); return true; } catch { return false; }
  }
  function parseJson(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    try { return JSON.parse(value); } catch { return null; }
  }

  // ---- 解密模块 ----
  function encodeUtf8(v) { return new TextEncoder().encode(v); }
  function decodeUtf8(v) { return new TextDecoder().decode(v); }
  function decodeBase64(v) {
    const b = atob(v);
    const o = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i);
    return o;
  }
  function xorBytes(input, key) {
    const o = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) o[i] = input[i] ^ key[i % key.length];
    return o;
  }
  function getSecureKey() {
    return encodeUtf8(`${SECURE_STORAGE_NAMESPACE}|${window.location.host}|${navigator.userAgent}`);
  }
  function decrypt(value) {
    if (typeof value !== 'string' || !value.startsWith(SECURE_STORAGE_PREFIX)) return value;
    try {
      const payload = value.slice(SECURE_STORAGE_PREFIX.length);
      return decodeUtf8(xorBytes(decodeBase64(payload), getSecureKey()));
    } catch { return value; }
  }
  function readPersisted(key) {
    const raw = getItem(key);
    if (!raw) return null;
    const dec = decrypt(raw);
    const parsed = parseJson(dec);
    return parsed === null ? dec : parsed;
  }

  // ---- 数据处理 ----
  function formatPrice(v) {
    const p = typeof v === 'number' ? v : Number.parseFloat(v);
    return Number.isFinite(p) ? p : 0;
  }
  function normalizeKeywords(t) {
    return String(t || '').split(/[,，\s]+/).map(k => k.trim().toLowerCase()).filter(Boolean);
  }
  function normalizeModel(n) { return String(n || '').trim().toLowerCase(); }
  function normalizeApiBase(b) {
    let nb = String(b || '').trim() || `${location.protocol}//${location.host}`;
    nb = nb.replace(/\/?v0\/management\/?$/i, '').replace(/\/+$/g, '');
    return /^https?:\/\//i.test(nb) ? nb : `${location.protocol}//${nb}`;
  }

  // ---- 网络请求 ----
  async function fetchJson(url, headers) {
    const res = await fetch(url, { method: 'GET', headers, cache: 'no-store' });
    const text = await res.text();
    const body = parseJson(text);
    if (!res.ok) throw new Error(body?.error?.message || body?.message || `HTTP ${res.status}`);
    return body;
  }

  async function fetchPricing() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(PRICING_URL, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`价格源请求失败 (${res.status})`);
      return await res.json();
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('价格源请求超时');
      throw new Error('价格源拉取失败，请检查网络或 CORS 限制');
    }
  }

  // ---- 业务逻辑 ----
  function readAuth() {
    const persisted = readPersisted(STORAGE_KEYS.auth);
    const state = persisted?.state || persisted;
    const apiBase = normalizeApiBase(state?.apiBase || state?.apiUrl || readPersisted('apiBase') || location.origin);
    const mKey = (state?.managementKey || readPersisted('managementKey') || '').trim();
    return { apiBase, managementKey: mKey };
  }

  async function fetchModelNames(overrideKey) {
    const auth = readAuth();
    const finalAuth = {
      apiBase: normalizeApiBase(auth.apiBase),
      managementKey: (overrideKey || auth.managementKey).trim(),
    };
    if (!finalAuth.managementKey) throw new Error('未检测到管理密钥，请手动输入。');

    const config = await fetchJson(`${finalAuth.apiBase}/v0/management/config`, { Authorization: `Bearer ${finalAuth.managementKey}` });
    const apiKeys = config?.apiKeys || config?.['api-keys'] || config?.raw?.apiKeys || [];
    const usableKey = apiKeys.find(k => !/^your-api-key/i.test(k)) || apiKeys[0];
    if (!usableKey) throw new Error('CPA 配置中无可用 API Key');

    const modelsRes = await fetchJson(`${finalAuth.apiBase}/v1/models`, { Authorization: `Bearer ${usableKey}` });
    const items = Array.isArray(modelsRes) ? modelsRes : (modelsRes?.data || modelsRes?.models || []);
    const names = new Set();
    items.forEach(i => {
      const n = normalizeModel(typeof i === 'string' ? i : (i.id || i.name));
      if (n) names.add(n);
    });
    if (names.size === 0) throw new Error('CPA 模型列表为空');
    return names;
  }

  function buildPrices(rawData, filter, allowedNames) {
    const keywords = normalizeKeywords(filter);
    const result = {};
    for (const provider of Object.values(rawData)) {
      if (!provider?.models) continue;
      for (const [mKey, model] of Object.entries(provider.models)) {
        const nName = normalizeModel(mKey);
        const matchFilter = keywords.length === 0 || keywords.some(k => nName.includes(k));
        if (matchFilter && allowedNames.has(nName)) {
          const prompt = formatPrice(model.cost?.input);
          const cacheRaw = formatPrice(model.cost?.cache_read ?? model.cost?.cache_write ?? 0);
          // 缓存价格为零时，取提示价格的 0.1 倍作为默认值
          const cache = cacheRaw !== 0 ? cacheRaw : prompt * 0.1;
          result[nName] = {
            prompt,
            completion: formatPrice(model.cost?.output),
            cache,
          };
        }
      }
    }
    return result;
  }

  // ---- 主流程 ----
  try {
    const [rawData, modelNames] = await Promise.all([
      fetchPricing(),
      fetchModelNames(manualKey),
    ]);
    const newPrices = buildPrices(rawData, filterText, modelNames);
    const newCount = Object.keys(newPrices).length;
    if (newCount === 0) throw new Error('无匹配模型，请检查关键词或模型列表');

    // 读取已存在的价格数据，将新数据合并进去（只覆盖接口有返回的模型，其余保持不动）
    const existingRaw = getItem(STORAGE_KEYS.prices);
    const existingPrices = parseJson(existingRaw) || {};
    const mergedPrices = Object.assign({}, existingPrices, newPrices);

    setItem(STORAGE_KEYS.prices, JSON.stringify(mergedPrices));
    setItem(STORAGE_KEYS.lastFilter, filterText);

    const addedCount = Object.keys(newPrices).filter(k => !(k in existingPrices)).length;
    const updatedCount = newCount - addedCount;
    return { ok: true, message: `同步成功：新增 ${addedCount} 个，更新 ${updatedCount} 个模型价格。页面即将刷新。` };
  } catch (e) {
    return { ok: false, message: e.message || '同步失败' };
  }
}

// ---- 页面内注入：读取管理密钥 ----

/**
 * 从页面 localStorage 中读取并解密管理密钥。
 * 此函数在页面上下文中执行。
 * @returns {{ ok: boolean, key?: string, message?: string }}
 */
function pageReadManagementKey() {
  const SECURE_STORAGE_PREFIX = 'enc::v1::';
  const SECURE_STORAGE_NAMESPACE = 'cli-proxy-api-webui::secure-storage';

  function encodeUtf8(v) { return new TextEncoder().encode(v); }
  function decodeUtf8(v) { return new TextDecoder().decode(v); }
  function decodeBase64(v) {
    const b = atob(v);
    const o = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) o[i] = b.charCodeAt(i);
    return o;
  }
  function xorBytes(input, key) {
    const o = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i++) o[i] = input[i] ^ key[i % key.length];
    return o;
  }
  function getSecureKey() {
    return encodeUtf8(`${SECURE_STORAGE_NAMESPACE}|${window.location.host}|${navigator.userAgent}`);
  }
  function decrypt(value) {
    if (typeof value !== 'string' || !value.startsWith(SECURE_STORAGE_PREFIX)) return value;
    try {
      const payload = value.slice(SECURE_STORAGE_PREFIX.length);
      return decodeUtf8(xorBytes(decodeBase64(payload), getSecureKey()));
    } catch { return value; }
  }
  function parseJson(v) {
    if (typeof v !== 'string' || !v.trim()) return null;
    try { return JSON.parse(v); } catch { return null; }
  }
  function readPersisted(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const dec = decrypt(raw);
    const parsed = parseJson(dec);
    return parsed === null ? dec : parsed;
  }

  try {
    const persisted = readPersisted('cli-proxy-auth');
    const state = persisted?.state || persisted;
    const mKey = (state?.managementKey || readPersisted('managementKey') || '').trim();
    if (!mKey) return { ok: false, message: '未找到管理密钥，请手动输入' };
    return { ok: true, key: mKey };
  } catch (e) {
    return { ok: false, message: e.message || '读取失败' };
  }
}

// ---- 按钮事件绑定 ----

/**
 * 切换管理密钥显示/隐藏。
 */
document.getElementById('toggleKeyBtn').addEventListener('click', () => {
  const input = document.getElementById('manualKeyInput');
  const btn = document.getElementById('toggleKeyBtn');
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  btn.innerHTML = isHidden ? '*' : '&#x1F441;';
});


document.getElementById('loadKeyBtn').addEventListener('click', async () => {
  const btn = document.getElementById('loadKeyBtn');
  const statusEl = document.getElementById('syncStatus');

  btn.disabled = true;
  try {
    const tabId = await getActiveTabId();
    const result = await runInTab(tabId, pageReadManagementKey);
    if (result?.ok) {
      document.getElementById('manualKeyInput').value = result.key;
      setStatus(statusEl, '管理密钥已自动加载', 'success');
    } else {
      setStatus(statusEl, result?.message || '读取失败', 'error');
    }
  } catch (e) {
    setStatus(statusEl, e.message || '执行出错', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('clearBtn').addEventListener('click', async () => {
  const btn = document.getElementById('clearBtn');
  const statusEl = document.getElementById('clearStatus');

  btn.disabled = true;
  setStatus(statusEl, '处理中...', 'info');

  try {
    const tabId = await getActiveTabId();
    const result = await runInTab(tabId, pageClearPrices);

    if (result?.ok) {
      setStatus(statusEl, result.message, 'success');
      // 延迟刷新页面，让用户看到提示
      setTimeout(async () => {
        await runInTab(tabId, () => location.reload());
      }, 800);
    } else {
      setStatus(statusEl, result?.message || '操作失败', 'error');
    }
  } catch (e) {
    setStatus(statusEl, e.message || '执行出错', 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('syncBtn').addEventListener('click', async () => {
  const btn = document.getElementById('syncBtn');
  const statusEl = document.getElementById('syncStatus');
  const filterText = document.getElementById('filterInput').value.trim();
  const manualKey = document.getElementById('manualKeyInput').value.trim();

  btn.disabled = true;
  btn.textContent = '同步中...';
  setStatus(statusEl, '正在拉取数据，请稍候...', 'info');

  try {
    const tabId = await getActiveTabId();
    const result = await runInTab(tabId, pageSyncPrices, [filterText, manualKey]);

    if (result?.ok) {
      setStatus(statusEl, result.message, 'success');
      setTimeout(async () => {
        await runInTab(tabId, () => location.reload());
      }, 800);
    } else {
      setStatus(statusEl, result?.message || '同步失败', 'error');
    }
  } catch (e) {
    setStatus(statusEl, e.message || '执行出错', 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '更新模型价格';
  }
});

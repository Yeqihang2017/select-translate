'use strict';

/* ============================ 配置 ============================ */

const DEFAULTS = {
  target: 'zh',
  engine: 'auto',
  cloudProvider: 'deepl',
  deeplKey: '',
  baiduAppId: '',
  baiduKey: ''
};

async function getCfg() {
  const v = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...(v || {}) };
}

/* ========================== 语言码映射 ========================== */

const DEEPL_LANG = {
  zh: 'ZH', en: 'EN', ja: 'JA', ko: 'KO', ru: 'RU', de: 'DE', fr: 'FR',
  es: 'ES', it: 'IT', pt: 'PT', ar: 'AR', tr: 'TR', vi: 'VI', th: 'TH'
};

const BAIDU_LANG = {
  zh: 'zh', en: 'en', ja: 'jp', ko: 'kor', ru: 'ru', ar: 'ara', th: 'th',
  hi: 'hi', de: 'de', fr: 'fra', es: 'spa', it: 'it', pt: 'pt', vi: 'vie', tr: 'tr'
};

/* ============================== MD5 ============================== */

function md5(input) {
  const bytes = new TextEncoder().encode(input);
  const len = bytes.length;
  const bitLen = len * 8;

  const total = (((len + 8) >> 6) + 1) * 64;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[len] = 0x80;

  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bitLen >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);

    let A = a0, B = b0, C = c0, D = d0;

    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }

      const tmp = D;
      D = C;
      C = B;

      const sum = (A + F + K[i] + M[g]) >>> 0;
      const sh = S[(i >> 4) * 4 + (i % 4)];
      B = (B + ((sum << sh) | (sum >>> (32 - sh)))) >>> 0;
      A = tmp;
    }

    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true);
  odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true);
  odv.setUint32(12, d0, true);

  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

/* ============================ 云端引擎 ============================ */

async function deeplTranslate(text, src, tgt, key) {
  if (!key) throw new Error('NO_CLOUD');
  const endpoint = key.trim().endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';

  const body = { text: [text], target_lang: DEEPL_LANG[tgt] || tgt.toUpperCase() };
  if (src && DEEPL_LANG[src]) body.source_lang = DEEPL_LANG[src];

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `DeepL-Auth-Key ${key.trim()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`DeepL ${res.status} ${detail.slice(0, 120)}`);
  }

  const data = await res.json();
  const out = data?.translations?.[0]?.text;
  if (!out) throw new Error('DeepL 返回为空');
  return out;
}

async function baiduTranslate(text, src, tgt, appid, key) {
  if (!appid || !key) throw new Error('NO_CLOUD');

  const salt = String(Date.now());
  const q = text;
  const from = BAIDU_LANG[src] || 'auto';
  const to = BAIDU_LANG[tgt] || 'zh';
  const sign = md5(appid + q + salt + key);

  const params = new URLSearchParams({ q, from, to, appid, salt, sign });

  const res = await fetch('https://fanyi-api.baidu.com/api/trans/vip/translate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!res.ok) throw new Error(`百度翻译 ${res.status}`);

  const data = await res.json();
  if (data.error_code) throw new Error(`百度翻译 ${data.error_code}: ${data.error_msg || ''}`);

  const out = (data.trans_result || []).map((r) => r.dst).join('\n');
  if (!out) throw new Error('百度翻译返回为空');
  return out;
}

async function cloudTranslate(text, src, tgt) {
  const cfg = await getCfg();

  if (cfg.cloudProvider === 'baidu') {
    const out = await baiduTranslate(text, src, tgt, cfg.baiduAppId, cfg.baiduKey);
    return { text: out, engine: '百度' };
  }
  const out = await deeplTranslate(text, src, tgt, cfg.deeplKey);
  return { text: out, engine: 'DeepL' };
}

/* ============================ 音标查询 ============================ */

async function fetchPhonetic(word) {
  const res = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
  if (!res.ok) return '';
  const data = await res.json();
  const entry = Array.isArray(data) ? data[0] : null;
  if (!entry) return '';

  if (entry.phonetic) return entry.phonetic;
  const p = (entry.phonetics || []).find((x) => x.text);
  return p ? p.text : '';
}

/* ======================== 内置引擎（offscreen） ======================== */

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (chrome.offscreen?.hasDocument) {
    const has = await chrome.offscreen.hasDocument();
    if (has) return;
  }
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = chrome.offscreen
    .createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: '在扩展上下文中运行 Chrome 内置翻译模型'
    })
    .catch(() => { /* 已存在则忽略 */ })
    .finally(() => { creatingOffscreen = null; });

  return creatingOffscreen;
}

async function builtinTranslate(text, src, tgt) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_TRANSLATE', text, source: src, target: tgt });
  if (!r || !r.ok) throw new Error(r?.error || 'NO_BUILTIN');
  return r.text;
}

/* ============================ 消息路由 ============================ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'builtin') {
    builtinTranslate(msg.text, msg.source, msg.target)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === 'cloud') {
    cloudTranslate(msg.text, msg.source, msg.target)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === 'phonetic') {
    fetchPhonetic(msg.word)
      .then((phonetic) => sendResponse({ ok: true, phonetic }))
      .catch(() => sendResponse({ ok: true, phonetic: '' }));
    return true;
  }

  if (msg.type === 'open-vocab') {
    (async () => {
      try {
        if (chrome.sidePanel?.open && sender.tab?.windowId != null) {
          await chrome.sidePanel.open({ windowId: sender.tab.windowId });
          return;
        }
      } catch { /* 需要用户手势，降级为整页打开 */ }
      chrome.runtime.openOptionsPage();
    })();
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'diag-target') {
    (async () => {
      const { tabStack = [] } = await chrome.storage.session.get({ tabStack: [] });
      const candidates = [...tabStack].reverse().filter((id) => id !== msg.selfTabId);

      for (const id of candidates) {
        try {
          await chrome.tabs.get(id);   // 确认标签页仍然存在
          return id;
        } catch { /* 已关闭，继续往前找 */ }
      }

      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return t ? t.id : null;
    })()
      .then((tabId) => sendResponse({ ok: true, tabId }))
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }

  if (msg.type === 'ping') {
    sendResponse({ ok: true });
    return false;
  }
});

// 点击工具栏图标直接打开侧边栏：不占用标签页，也不会抢走页面焦点
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.warn('[划词翻译] sidePanel 初始化失败', e));
}

/* ======================== 目标标签页追踪 ======================== */

// 设置页自身也是一个标签页，打开后会成为 active tab。
// 因此维护一个最近激活标签页的栈，诊断时取"设置页之前的那一个"。
// 存在 storage.session 里，避免 service worker 休眠后丢失。

async function pushTab(id) {
  if (typeof id !== 'number') return;
  try {
    const { tabStack = [] } = await chrome.storage.session.get({ tabStack: [] });
    const next = tabStack.filter((x) => x !== id);
    next.push(id);
    if (next.length > 8) next.shift();
    await chrome.storage.session.set({ tabStack: next });
  } catch { /* ignore */ }
}

chrome.tabs.onActivated.addListener(({ tabId }) => { pushTab(tabId); });

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) pushTab(tab.id);
  } catch { /* ignore */ }
});

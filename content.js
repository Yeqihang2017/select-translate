(() => {
  'use strict';
  if (window.__ST_LOADED__) return;
  window.__ST_LOADED__ = true;

  const DEFAULTS = {
    target: 'zh',
    engine: 'auto',            // auto | builtin | cloud
    cloudProvider: 'deepl',    // deepl | baidu
    deeplKey: '',
    baiduAppId: '',
    baiduKey: ''
  };

  const MAX_CHARS = 5000;      // 段落上限
  const CHUNK_CHARS = 800;     // 本地模型单次输入上限
  const WORDIFY_LIMIT = 3000;  // 超过此长度不再逐词包裹，避免 DOM 过重
  const CACHE_MAX = 400;

  let cfg = { ...DEFAULTS };
  const cfgReady = chrome.storage.local
    .get(DEFAULTS)
    .then((v) => { cfg = { ...DEFAULTS, ...(v || {}) }; })
    .catch(() => {});

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local') return;
    for (const k in ch) if (k in DEFAULTS) cfg[k] = ch[k].newValue;
  });

  const translators = new Map();
  const cache = new Map();
  const wordCache = new Map();
  let vocab = {};

  chrome.storage.local.get({ vocab: {} })
    .then((v) => { vocab = v.vocab || {}; })
    .catch(() => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.vocab) vocab = ch.vocab.newValue || {};
  });

  let reqId = 0;
  let lastText = '';
  let lastRect = null;
  let currentSrc = '';
  let currentSrcLang = 'en';
  let currentTgtLang = 'zh';

  let host = null, shadow = null, card = null;
  let tagEl = null, pairEl = null, srcEl = null, bodyEl = null, msEl = null;
  let wordEl = null, wordTitle = null, wordPhon = null, wordDef = null, wordBtn = null;
  let activeWord = '';

  const LANG_LABEL = {
    zh: '中文', en: '英语', ja: '日语', ko: '韩语', ru: '俄语', ar: '阿拉伯语',
    th: '泰语', hi: '印地语', de: '德语', fr: '法语', es: '西班牙语', it: '意大利语',
    pt: '葡萄牙语', vi: '越南语', tr: '土耳其语'
  };
  const langName = (c) => LANG_LABEL[c] || c.toUpperCase();

  /* ----------------------------- 语言检测 ----------------------------- */

  function detectLang(t) {
    if (/[\u3040-\u30ff]/.test(t)) return 'ja';
    if (/[\uac00-\ud7af\u1100-\u11ff]/.test(t)) return 'ko';
    if (/[\u4e00-\u9fff]/.test(t)) return 'zh';
    if (/[\u0400-\u04ff]/.test(t)) return 'ru';
    if (/[\u0600-\u06ff]/.test(t)) return 'ar';
    if (/[\u0e00-\u0e7f]/.test(t)) return 'th';
    if (/[\u0900-\u097f]/.test(t)) return 'hi';
    return 'en';
  }

  /* ------------------------------ 分词 -------------------------------- */

  function tokenize(text, lang) {
    if (typeof Intl === 'undefined' || !Intl.Segmenter) {
      return [{ s: text, w: false }];
    }
    try {
      const seg = new Intl.Segmenter(lang, { granularity: 'word' });
      return Array.from(seg.segment(text), (p) => ({ s: p.segment, w: !!p.isWordLike }));
    } catch {
      return [{ s: text, w: false }];
    }
  }

  function normWord(w) {
    return /^[A-Za-z]/.test(w) ? w.toLowerCase() : w;
  }

  /* ------------------------------- 弹窗 ------------------------------- */

  const CSS = `
    .card {
      box-sizing: border-box;
      width: max-content;
      min-width: 260px;
      max-width: 420px;
      background: #1c1c1e;
      color: #f2f2f2;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.34);
      font: 14px/1.55 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      padding: 10px 12px 8px;
    }
    .bar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 11px; color: #9a9a9f; }
    .tag { padding: 1px 6px; border-radius: 4px; background: rgba(255,255,255,.09); color: #c9c9ce; white-space: nowrap; }
    .pair { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .close { border: 0; background: transparent; color: #9a9a9f; font-size: 16px; line-height: 1; cursor: pointer; padding: 0 2px; }
    .close:hover { color: #fff; }

    .src {
      color: #a3a3a9;
      font-size: 13px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 104px;
      overflow-y: auto;
      overscroll-behavior: contain;
    }
    .divider { height: 1px; background: rgba(255,255,255,.09); margin: 8px 0; }
    .body { white-space: pre-wrap; word-break: break-word; user-select: text; max-height: 300px; overflow-y: auto; overscroll-behavior: contain; }
    .body.err { color: #ff9f9f; }

    .w { cursor: pointer; border-radius: 3px; }
    .w:hover { background: rgba(120,180,255,.24); }
    .w.hit { background: rgba(255,196,80,.20); box-shadow: inset 0 -1px 0 rgba(255,196,80,.75); }

    .word { margin-top: 8px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,.14); }
    .word-head { display: flex; align-items: baseline; gap: 8px; }
    .w-title { font-weight: 500; color: #ffd08a; font-size: 14px; }
    .w-phon { font-size: 12px; color: #8f8f95; }
    .w-add { margin-left: auto; border: 0; background: rgba(255,255,255,.08); color: #c9c9ce; border-radius: 5px; padding: 2px 8px; font-size: 11px; cursor: pointer; white-space: nowrap; }
    .w-add:hover { background: rgba(255,255,255,.14); }
    .w-add.on { background: rgba(255,196,80,.18); color: #ffd08a; }
    .w-def { margin-top: 4px; color: #e6e6ea; }

    .foot { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; font-size: 11px; color: #7d7d82; }
    .acts { display: flex; gap: 12px; }
    .copy, .vocab-link { border: 0; background: transparent; color: #7d7d82; cursor: pointer; font-size: 11px; padding: 0; }
    .copy:hover, .vocab-link:hover { color: #fff; }

    .sk { height: 12px; border-radius: 3px; background: rgba(255,255,255,.10); margin: 6px 0; animation: p 1.1s ease-in-out infinite; }
    .sk.b { width: 78%; animation-delay: .12s; }
    .sk.c { width: 52%; animation-delay: .24s; }
    @keyframes p { 0%,100% { opacity: .45 } 50% { opacity: 1 } }
  `;

  function ensureUI() {
    if (host) return;
    host = document.createElement('div');
    host.style.cssText = 'all:initial;display:block;position:fixed;left:0;top:0;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="card" hidden>
        <div class="bar">
          <span class="tag">…</span>
          <span class="pair"></span>
          <button class="close" title="关闭">×</button>
        </div>
        <div class="src"></div>
        <div class="divider"></div>
        <div class="body"></div>
        <div class="word" hidden>
          <div class="word-head">
            <span class="w-title"></span>
            <span class="w-phon"></span>
            <button class="w-add">＋ 生词本</button>
          </div>
          <div class="w-def"></div>
        </div>
        <div class="foot">
          <span class="ms"></span>
          <span class="acts">
            <button class="copy">复制译文</button>
            <button class="vocab-link">生词本</button>
          </span>
        </div>
      </div>`;

    card = shadow.querySelector('.card');
    tagEl = shadow.querySelector('.tag');
    pairEl = shadow.querySelector('.pair');
    srcEl = shadow.querySelector('.src');
    bodyEl = shadow.querySelector('.body');
    msEl = shadow.querySelector('.ms');
    wordEl = shadow.querySelector('.word');
    wordTitle = shadow.querySelector('.w-title');
    wordPhon = shadow.querySelector('.w-phon');
    wordDef = shadow.querySelector('.w-def');
    wordBtn = shadow.querySelector('.w-add');

    shadow.querySelector('.close').addEventListener('click', hide);

    shadow.querySelector('.copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(bodyEl.textContent || '');
        msEl.textContent = '已复制';
      } catch { msEl.textContent = '复制失败'; }
    });

    shadow.querySelector('.vocab-link').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'open-vocab' }).catch(() => {});
    });

    srcEl.addEventListener('click', (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement) || !t.classList.contains('w')) return;
      const w = t.dataset.w;
      if (w) lookupWord(w, t);
    });

    wordBtn.addEventListener('click', () => toggleVocab(activeWord));

    host.addEventListener('mousedown', (e) => e.stopPropagation(), true);

    (document.body || document.documentElement).appendChild(host);
  }

  function place() {
    if (!host || !lastRect) return;
    const w = host.offsetWidth || 320;
    const h = host.offsetHeight || 100;
    const gap = 8;

    const left = Math.min(Math.max(gap, lastRect.left), window.innerWidth - w - gap);
    let top = lastRect.bottom + gap;
    if (top + h > window.innerHeight - gap) top = Math.max(gap, lastRect.top - h - gap);

    host.style.left = `${Math.max(0, left)}px`;
    host.style.top = `${Math.max(0, top)}px`;
  }

  function render({ tag, pair, src, out, ms, isErr }) {
    ensureUI();
    tagEl.textContent = tag;
    pairEl.textContent = pair;
    msEl.textContent = ms || '';
    if (src != null) srcEl.innerHTML = src;
    bodyEl.innerHTML = out != null ? out : '';
    bodyEl.classList.toggle('err', !!isErr);
    if (wordEl) wordEl.hidden = true;   // 新选区重置词卡
    activeWord = '';
    card.hidden = false;
    requestAnimationFrame(place);
  }

  function hide() {
    if (card) card.hidden = true;
    if (wordEl) wordEl.hidden = true;
    activeWord = '';
    lastText = '';
  }

  /* ---------------------------- 原文渲染 ------------------------------ */

  function escapeHTML(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function renderSource(text, lang) {
    if (text.length > WORDIFY_LIMIT) return escapeHTML(text);

    return tokenize(text, lang).map((p) => {
      if (!p.w) return escapeHTML(p.s);
      const hit = vocab[normWord(p.s)] ? ' hit' : '';
      return `<span class="w${hit}" data-w="${escapeHTML(p.s)}">${escapeHTML(p.s)}</span>`;
    }).join('');
  }

  /* ---------------------------- 生词本 -------------------------------- */

  async function toggleVocab(word) {
    if (!word) return;
    const key = normWord(word);
    const next = { ...vocab };

    if (next[key]) {
      delete next[key];
    } else {
      next[key] = {
        w: word,
        t: wordDef.textContent || '',
        ts: Date.now()
      };
    }

    vocab = next;
    await chrome.storage.local.set({ vocab: next });
    syncWordBtn(word);
    refreshHits();
  }

  function syncWordBtn(word) {
    const saved = !!vocab[normWord(word)];
    wordBtn.textContent = saved ? '✓ 已收藏' : '＋ 生词本';
    wordBtn.classList.toggle('on', saved);
  }

  function refreshHits() {
    if (!shadow) return;
    shadow.querySelectorAll('.w').forEach((el) => {
      el.classList.toggle('hit', !!vocab[normWord(el.dataset.w || '')]);
    });
  }

  /* ---------------------------- 单词查询 ------------------------------ */

  async function lookupWord(word, el) {
    activeWord = word;
    ensureUI();
    wordEl.hidden = false;
    wordTitle.textContent = word;
    wordPhon.textContent = '';
    wordDef.textContent = '查询中…';
    syncWordBtn(word);
    requestAnimationFrame(place);

    // 原文与目标语言相同时，词义查询退化为英文（对中文用户更实用）
    const wSrc = currentSrcLang;
    const wTgt = currentSrcLang === currentTgtLang ? 'en' : currentTgtLang;

    const key = `${wSrc}|${wTgt}|${word}`;
    if (wordCache.has(key)) {
      wordDef.textContent = wordCache.get(key);
      return;
    }

    // 音标（仅英文，尽力而为）
    if (/^[A-Za-z][A-Za-z'-]*$/.test(word)) {
      chrome.runtime.sendMessage({ type: 'phonetic', word })
        .then((r) => { if (r?.ok && r.phonetic) wordPhon.textContent = r.phonetic; })
        .catch(() => {});
    }

    try {
      const r = await translateText(word, wSrc, wTgt, false);
      if (activeWord !== word) return;
      wordDef.textContent = r.text;
      wordCache.set(key, r.text);
    } catch (e) {
      if (activeWord !== word) return;
      wordDef.textContent = friendlyError(e);
    }
  }

  /* ------------------------------ 翻译引擎 ---------------------------- */

  async function getTranslator(src, tgt) {
    const key = `${src}|${tgt}`;
    if (translators.has(key)) return translators.get(key);

    const p = (async () => {
      if (typeof Translator === 'undefined') throw new Error('NO_BUILTIN');
      const avail = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
      if (avail === 'unavailable' || avail === 'no') throw new Error('PAIR_UNSUPPORTED');
      return await Translator.create({ sourceLanguage: src, targetLanguage: tgt });
    })();

    translators.set(key, p);
    try {
      return await p;
    } catch (e) {
      translators.delete(key);
      throw e;
    }
  }

  async function builtinTranslate(text, src, tgt) {
    if (typeof Translator !== 'undefined') {
      const t = await getTranslator(src, tgt);
      return await t.translate(text);
    }
    const r = await chrome.runtime.sendMessage({ type: 'builtin', text, source: src, target: tgt });
    if (!r || !r.ok) throw new Error(r?.error || 'NO_BUILTIN');
    return r.text;
  }

  async function cloudTranslate(text, src, tgt) {
    const r = await chrome.runtime.sendMessage({ type: 'cloud', text, source: src, target: tgt });
    if (!r || !r.ok) throw new Error(r?.error || '云端翻译失败');
    return { text: r.text, engine: r.engine };
  }

  /* 长文本按句切块，避免单次输入过长 */
  function splitChunks(text, limit) {
    const sentences = [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        const seg = new Intl.Segmenter(undefined, { granularity: 'sentence' });
        for (const s of seg.segment(text)) sentences.push(s.segment);
      } catch { /* fall through */ }
    }
    if (!sentences.length) sentences.push(...text.split(/(?<=[.!?。！？；\n])\s*/));

    const chunks = [];
    let cur = '';
    for (const s of sentences) {
      if (!s) continue;
      if (cur && cur.length + s.length > limit) {
        chunks.push(cur);
        cur = '';
      }
      if (s.length > limit) {
        for (let i = 0; i < s.length; i += limit) chunks.push(s.slice(i, i + limit));
      } else {
        cur += s;
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  async function translateText(text, src, tgt, reportProgress) {
    const useBuiltin = cfg.engine !== 'cloud';
    const needsChunk = text.length > CHUNK_CHARS;

    if (!useBuiltin) {
      const r = await cloudTranslate(text, src, tgt);
      return { text: r.text, engine: r.engine };
    }

    if (!needsChunk) {
      try {
        return { text: await builtinTranslate(text, src, tgt), engine: '本地' };
      } catch (e) {
        if (cfg.engine === 'builtin') throw e;
        const r = await cloudTranslate(text, src, tgt);
        return { text: r.text, engine: r.engine };
      }
    }

    const chunks = splitChunks(text, CHUNK_CHARS);
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      if (reportProgress) reportProgress(i + 1, chunks.length);
      parts.push(await builtinTranslate(chunks[i], src, tgt));
    }
    return { text: parts.join(''), engine: '本地' };
  }

  function trimCache() {
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  /* ------------------------------ 主流程 ------------------------------ */

  async function translate(text, rect) {
    await cfgReady;
    const myId = ++reqId;
    const src = detectLang(text);
    const tgt = cfg.target || 'zh';

    lastRect = rect;
    currentSrc = text;
    currentSrcLang = src;
    currentTgtLang = tgt;

    const pair = `${langName(src)} → ${langName(tgt)}`;
    const srcHTML = renderSource(text, src);

    if (src === tgt) {
      render({ tag: '提示', pair, src: srcHTML, out: '已经是目标语言', ms: '' });
      return;
    }

    const key = `${src}|${tgt}|${text}`;
    if (cache.has(key)) {
      render({ tag: '缓存', pair, src: srcHTML, out: escapeHTML(cache.get(key)), ms: '0 ms' });
      return;
    }

    render({
      tag: text.length > CHUNK_CHARS ? `翻译中 1/${splitChunks(text, CHUNK_CHARS).length}` : '翻译中',
      pair, src: srcHTML,
      out: '<div class="sk"></div><div class="sk b"></div><div class="sk c"></div>',
      ms: ''
    });

    const t0 = performance.now();
    try {
      const r = await translateText(text, src, tgt, (i, n) => {
        if (myId === reqId) tagEl.textContent = `翻译中 ${i}/${n}`;
      });

      if (myId !== reqId) return;
      cache.set(key, r.text);
      trimCache();

      render({
        tag: r.engine,
        pair,
        src: srcHTML,
        out: escapeHTML(r.text),
        ms: `${Math.round(performance.now() - t0)} ms`
      });
    } catch (e) {
      if (myId !== reqId) return;
      console.warn('[划词翻译] 翻译失败', e);
      render({ tag: '失败', pair, src: srcHTML, out: escapeHTML(friendlyError(e)), ms: '', isErr: true });
    }
  }

  function friendlyError(e) {
    const m = String(e?.message || e);
    if (m.includes('NO_BUILTIN')) return '本地引擎不可用：请在设置中改用云端引擎，或升级到 Chrome 138+。';
    if (m.includes('PAIR_UNSUPPORTED')) return '本地模型不支持该语向，请在设置中配置云端 API 兜底。';
    if (m.includes('NO_CLOUD')) return '未配置云端 API，且本地模型不支持该语向。';
    if (m.includes('NOT_ALLOWED')) return '翻译请求被浏览器拒绝，请重新划词再试一次。';
    return `翻译失败：${m}`;
  }

  /* ---------------------------- 选区捕获 ------------------------------ */

  function readSelection() {
    const active = document.activeElement;
    if (active && /^(INPUT|TEXTAREA)$/.test(active.tagName)) {
      const s = active.selectionStart, e = active.selectionEnd;
      if (typeof s === 'number' && typeof e === 'number' && e > s) {
        const t = active.value.slice(s, e).trim();
        if (t) return { text: t, rect: active.getBoundingClientRect() };
      }
      return null;
    }

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

    const text = sel.toString().trim();
    if (!text) return null;

    let rect = null;
    try {
      rect = sel.getRangeAt(0).getBoundingClientRect();
    } catch { /* ignore */ }
    if (!rect || (!rect.width && !rect.height)) {
      rect = { left: 40, top: 40, bottom: 60, width: 0, height: 20 };
    }
    return { text, rect };
  }

  function isValid(text) {
    if (!text) return false;
    if (text.length > MAX_CHARS) return false;
    return /[\p{L}\p{N}]/u.test(text);
  }

  function onSelect() {
    requestAnimationFrame(() => {
      const s = readSelection();
      if (!s || !isValid(s.text)) {
        console.debug('[划词翻译] 无有效选区', s ? `len=${s.text.length}` : 'null');
        if (lastText) hide();
        return;
      }
      if (s.text === lastText) return;
      lastText = s.text;
      console.debug('[划词翻译] 选区', s.text.length, '字符');
      translate(s.text, s.rect);
    });
  }

  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return;
    if (e.target === host) return;
    onSelect();
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key === 'Shift' || e.key.startsWith('Arrow')) onSelect();
  }, true);

  document.addEventListener('mousedown', (e) => {
    if (e.target !== host && card && !card.hidden) hide();
  }, true);

  window.addEventListener('scroll', (e) => {
    if (e.target === host) return;          // 弹窗内部滚动不关闭
    if (card && !card.hidden) hide();
  }, { capture: true, passive: true });

  window.addEventListener('resize', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);

  /* ------------------------------ 诊断 ------------------------------ */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.type !== 'diag') return;
    let sel = '';
    try { sel = (window.getSelection()?.toString() || '').slice(0, 40); } catch { /* ignore */ }
    sendResponse({
      loaded: true,
      url: location.href,
      protocol: location.protocol,
      topFrame: window.top === window,
      hasTranslator: typeof Translator !== 'undefined',
      hasSelection: typeof window.getSelection === 'function',
      selection: sel,
      cfg
    });
    return false;
  });

  console.debug('[划词翻译] content script ready:', location.href);

  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1200));
  idle(() => {
    if (typeof Translator === 'undefined') return;
    Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh' })
      .then((a) => {
        if (a === 'available' || a === 'readily') {
          return Translator.create({ sourceLanguage: 'en', targetLanguage: 'zh' });
        }
      })
      .catch(() => {});
  });
})();

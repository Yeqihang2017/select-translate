'use strict';

const DEFAULTS = {
  target: 'zh',
  engine: 'auto',
  cloudProvider: 'deepl',
  deeplKey: '',
  baiduAppId: '',
  baiduKey: ''
};

const $ = (id) => document.getElementById(id);

const fields = {
  target: $('target'),
  engine: $('engine'),
  cloudProvider: $('cloudProvider'),
  deeplKey: $('deeplKey'),
  baiduAppId: $('baiduAppId'),
  baiduKey: $('baiduKey')
};

const statusEl = $('status');

function setStatus(msg) {
  statusEl.textContent = msg;
  if (msg) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = ''; }, 2600);
}

function syncProvider() {
  const isBaidu = fields.cloudProvider.value === 'baidu';
  $('deeplFields').hidden = isBaidu;
  $('baiduFields').hidden = !isBaidu;
  syncCloudBadge();
}

function syncCloudBadge() {
  const el = $('cloudState');
  if (!el) return;
  const configured = fields.cloudProvider.value === 'baidu'
    ? !!(fields.baiduAppId.value.trim() && fields.baiduKey.value.trim())
    : !!fields.deeplKey.value.trim();
  el.textContent = configured ? '已配置' : '未配置';
  el.classList.toggle('on', configured);
}

async function load() {
  const cfg = await chrome.storage.local.get(DEFAULTS);
  fields.target.value = cfg.target;
  fields.engine.value = cfg.engine;
  fields.cloudProvider.value = cfg.cloudProvider;
  fields.deeplKey.value = cfg.deeplKey || '';
  fields.baiduAppId.value = cfg.baiduAppId || '';
  fields.baiduKey.value = cfg.baiduKey || '';
  syncProvider();
  await renderVocab();
}

async function save() {
  const cfg = {
    target: fields.target.value,
    engine: fields.engine.value,
    cloudProvider: fields.cloudProvider.value,
    deeplKey: fields.deeplKey.value.trim(),
    baiduAppId: fields.baiduAppId.value.trim(),
    baiduKey: fields.baiduKey.value.trim()
  };
  await chrome.storage.local.set(cfg);
  syncCloudBadge();
  setStatus('已保存');
}

/* ---------------------------- 生词本 ---------------------------- */

async function getVocab() {
  const { vocab } = await chrome.storage.local.get({ vocab: {} });
  return vocab || {};
}

async function renderVocab() {
  const vocab = await getVocab();
  const list = $('vocabList');
  const entries = Object.entries(vocab).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));

  $('vocabCount').textContent = entries.length ? `（${entries.length}）` : '';

  if (!entries.length) {
    list.innerHTML = '<div class="empty">还没有收藏。在弹窗里点任意单词，再点「＋ 生词本」即可加入。</div>';
    return;
  }

  list.innerHTML = entries.map(([key, v]) => `
    <div class="vitem">
      <span class="vw" title="${esc(v.w || key)}">${esc(v.w || key)}</span>
      <span class="vt" title="${esc(v.t || '')}">${esc(v.t || '—')}</span>
      <button class="vdel" data-key="${esc(key)}" title="移除">×</button>
    </div>`).join('');

  list.querySelectorAll('.vdel').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const vocabNow = await getVocab();
      delete vocabNow[btn.dataset.key];
      await chrome.storage.local.set({ vocab: vocabNow });
      await renderVocab();
    });
  });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* --------------------------- 引擎检测 --------------------------- */

async function testEngine() {
  setStatus('检测中…');

  if (typeof Translator === 'undefined') {
    setStatus('当前浏览器不支持内置翻译（需 Chrome 138+ 桌面版）');
    return;
  }

  const tgt = fields.target.value;
  const src = tgt === 'en' ? 'zh' : 'en';

  try {
    const a = await Translator.availability({ sourceLanguage: src, targetLanguage: tgt });
    if (a === 'available' || a === 'readily') {
      setStatus(`本地引擎可用（${src} → ${tgt}）`);
    } else if (a === 'downloadable' || a === 'after-download' || a === 'downloading') {
      setStatus(`语言包待下载（${src} → ${tgt}），首次划词时会自动下载`);
    } else {
      setStatus(`该语向不可用（${src} → ${tgt}）：${a}`);
    }
  } catch (e) {
    setStatus(`检测失败：${e?.message || e}`);
  }
}

/* ----------------------------- 诊断 ----------------------------- */

async function diagnose() {
  const out = $('diagOut');
  out.classList.add('on');
  out.textContent = '检测中…';

  const chromeVer = (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1] || '未知';
  const lines = [`浏览器内核：Chrome ${chromeVer}`];

  // 侧边栏中 getCurrent() 返回 undefined；标签页中返回自身。
  // 侧边栏不抢焦点，直接取当前活动标签页即可。
  let tabId = null;
  let where = '侧边栏';

  try {
    const self = await chrome.tabs.getCurrent();
    if (self?.id != null) {
      where = '标签页';
      const r = await chrome.runtime.sendMessage({ type: 'diag-target', selfTabId: self.id });
      tabId = r?.tabId ?? null;
    }
  } catch { /* ignore */ }

  if (tabId == null) {
    for (const q of [{ active: true, currentWindow: true }, { active: true, lastFocusedWindow: true }]) {
      try {
        const [t] = await chrome.tabs.query(q);
        if (t?.id != null) { tabId = t.id; break; }
      } catch { /* ignore */ }
    }
  }

  lines.push(`运行位置：${where}`);

  if (tabId == null) {
    lines.push('找不到可检测的标签页。请先打开一个普通网页，再回到本页点检测。');
    out.textContent = lines.join('\n');
    return;
  }

  lines.push(`目标标签页 ID：${tabId}`);

  let res = null;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'diag' });
  } catch {
    res = null;
  }

  if (!res || !res.loaded) {
    lines.push('');
    lines.push('✗ 内容脚本未响应：扩展没有注入到这个页面');
    lines.push('');
    lines.push('按顺序排查：');
    lines.push('1. 打开 chrome://extensions，看本扩展是否显示「错误」；改过代码需点「重新加载」，再刷新网页');
    lines.push('2. 页面是 chrome:// 、扩展商店、PDF 阅读器 —— 浏览器禁止注入，无解');
    lines.push('3. 页面是 file:// 本地文件 —— 需在扩展详情页开启「允许访问文件网址」');
    lines.push('4. Chrome 版本低于 138 —— 本扩展的最低要求');
    lines.push('');
    lines.push('提示：如果目标标签页不对，先切到要检测的网页，再切回本页点检测。');
  } else {
    lines.push(`页面地址：${res.url}`);
    lines.push(`顶层 frame：${res.topFrame ? '是' : '否'}`);
    lines.push(`本地模型 Translator：${res.hasTranslator ? '可用' : '不可用'}`);
    lines.push(`选区 API：${res.hasSelection ? '正常' : '异常'}`);
    lines.push(`当前选区：${res.selection ? JSON.stringify(res.selection) : '空（先选中一段文字再点检测）'}`);
    lines.push(`目标语言：${res.cfg?.target}　引擎策略：${res.cfg?.engine}`);

    if (res.hasTranslator) {
      try {
        const a = await Translator.availability({
          sourceLanguage: 'en',
          targetLanguage: res.cfg?.target || 'zh'
        });
        lines.push(`en → ${res.cfg?.target || 'zh'} 可用性：${a}`);
      } catch (e) {
        lines.push(`可用性查询失败：${e?.message || e}`);
      }
    } else {
      lines.push('');
      lines.push('⚠ 页面拿不到 Translator，会自动走 offscreen 兜底或云 API。');
    }
  }

  out.textContent = lines.join('\n');
}

/* ---------------------------- 事件绑定 ---------------------------- */

fields.cloudProvider.addEventListener('change', syncProvider);
[fields.deeplKey, fields.baiduAppId, fields.baiduKey].forEach((el) => {
  el.addEventListener('input', syncCloudBadge);
});
$('save').addEventListener('click', save);
$('test').addEventListener('click', testEngine);
$('diag').addEventListener('click', diagnose);

$('export').addEventListener('click', async () => {
  const vocab = await getVocab();
  const blob = new Blob([JSON.stringify(vocab, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocab-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('clear').addEventListener('click', async () => {
  const vocab = await getVocab();
  if (!Object.keys(vocab).length) return;
  if (!confirm('确定清空全部生词？此操作不可撤销。')) return;
  await chrome.storage.local.set({ vocab: {} });
  await renderVocab();
  setStatus('已清空');
});

load();

'use strict';

const translators = new Map();

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'OFFSCREEN_TRANSLATE') return;

  (async () => {
    const t = await getTranslator(msg.source, msg.target);
    const text = await t.translate(msg.text);
    return text;
  })()
    .then((text) => sendResponse({ ok: true, text }))
    .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));

  return true;
});

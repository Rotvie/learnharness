'use strict';
// Minimal AnkiConnect client (protocol version 6). Runs in the backend (Node),
// so AnkiConnect's browser CORS allowlist does not apply.

const MODEL_NAME = 'LearnHarness';
const FIELDS = ['Question', 'Answer', 'Proposition', 'Source', 'LHId'];
// Current template: no fixed colors (Anki's light/dark theme applies); context only when present.
const CSS = `.card { font-family: system-ui, sans-serif; font-size: 20px; line-height: 1.5; text-align: center; }
.lh-q, .lh-a { display: inline-block; text-align: left; max-width: 40em; }
.lh-ctx { margin-top: 1.2em; font-size: 14px; opacity: .6; }
.lh-src { margin-top: .3em; font-style: italic; }
pre { text-align: left; overflow-x: auto; padding: .6em; border-radius: 6px; background: rgba(127,127,127,.12); }
table { border-collapse: collapse; margin: 0 auto; }
td, th { border: 1px solid rgba(127,127,127,.4); padding: .25em .5em; }`;
const TEMPLATES = [{
  Name: 'Recall',
  Front: '<div class="lh-q">{{Question}}</div>',
  Back: '{{FrontSide}}\n<hr id="answer">\n<div class="lh-a">{{Answer}}</div>\n{{#Proposition}}<div class="lh-ctx">{{Proposition}}</div>{{/Proposition}}\n{{#Source}}<div class="lh-ctx lh-src">{{Source}}</div>{{/Source}}',
}];
// Earlier Anki Bridge versions. A note type still exactly like one of these is upgraded;
// anything else was customized in Anki and is left alone.
const LEGACY = [{
  css: `.card { font-family: system-ui, sans-serif; font-size: 20px; text-align: center; color: black; background-color: white; }
.nightMode .card, .card.nightMode { color: #eee; background-color: #1e1e1e; }
.lh-question, .lh-answer { text-align: left; display: inline-block; max-width: 40em; }
.lh-context { margin-top: 1.5em; font-size: 14px; opacity: .65; }
pre { text-align: left; overflow-x: auto; padding: .6em; border-radius: 6px; background: rgba(127,127,127,.12); }
table { border-collapse: collapse; margin: 0 auto; } td, th { border: 1px solid rgba(127,127,127,.4); padding: .25em .5em; }`,
  Front: '<div class="lh-question">{{Question}}</div>',
  Back: '{{FrontSide}}\n<hr id="answer">\n<div class="lh-answer">{{Answer}}</div>\n<div class="lh-context">{{Proposition}}<br>{{Source}}</div>',
}];
const same = (a, b) => String(a ?? '').trim() === String(b ?? '').trim();

class AnkiError extends Error {}

function createClient({ url, apiKey, fetchImpl = globalThis.fetch, timeoutMs = 15000 }) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw new AnkiError('Invalid AnkiConnect URL.'); }
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw new AnkiError('AnkiConnect URL must use http or https.');
  async function invoke(action, params = {}) {
    const body = { action, version: 6, params, ...(apiKey ? { key: apiKey } : {}) };
    let response;
    try {
      response = await fetchImpl(endpoint.href, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      throw new AnkiError(`Anki not reachable at ${endpoint.origin} — open Anki with AnkiConnect installed. (${error?.cause?.code || error?.name || error?.message || 'network error'})`);
    }
    if (!response.ok) throw new AnkiError(`AnkiConnect returned HTTP ${response.status}.`);
    let data;
    try { data = await response.json(); } catch { throw new AnkiError('AnkiConnect returned an invalid response.'); }
    if (!data || typeof data !== 'object' || !('result' in data) || !('error' in data)) throw new AnkiError('Unexpected AnkiConnect response. Is this URL really AnkiConnect?');
    if (data.error) throw new AnkiError(`AnkiConnect ${action}: ${data.error}`);
    return data.result;
  }
  async function version() {
    const v = await invoke('version');
    if (!Number.isInteger(v) || v < 6) throw new AnkiError(`AnkiConnect version ${v} is too old; version 6 or later is required.`);
    return v;
  }
  // Returns { created } | { upgraded } | { customized } | {} (already current).
  async function ensureModel() {
    const names = await invoke('modelNames');
    if (!names.includes(MODEL_NAME)) {
      await invoke('createModel', { modelName: MODEL_NAME, inOrderFields: FIELDS, css: CSS, isCloze: false, cardTemplates: TEMPLATES });
      return { created: true };
    }
    const fields = await invoke('modelFieldNames', { modelName: MODEL_NAME });
    const missing = FIELDS.filter(f => !fields.includes(f));
    if (missing.length) throw new AnkiError(`The Anki note type "${MODEL_NAME}" exists but lacks fields: ${missing.join(', ')}. Rename that note type in Anki so Anki Bridge can create its own.`);
    const [templates, styling] = await Promise.all([invoke('modelTemplates', { modelName: MODEL_NAME }), invoke('modelStyling', { modelName: MODEL_NAME })]);
    const recall = templates?.Recall, templateNames = Object.keys(templates ?? {});
    const matches = version => templateNames.length === 1 && recall && same(recall.Front, version.Front) && same(recall.Back, version.Back) && same(styling?.css, version.css);
    const current = { Front: TEMPLATES[0].Front, Back: TEMPLATES[0].Back, css: CSS };
    if (matches(current)) return {};
    if (!LEGACY.some(matches)) return { customized: true };
    await invoke('updateModelTemplates', { model: { name: MODEL_NAME, templates: { Recall: { Front: current.Front, Back: current.Back } } } });
    await invoke('updateModelStyling', { model: { name: MODEL_NAME, css: CSS } });
    return { upgraded: true };
  }
  const ensureDeck = name => invoke('createDeck', { deck: name });
  async function findByLhId(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AnkiError('Invalid card identity.');
    return invoke('findNotes', { query: `"note:${MODEL_NAME}" "LHId:${id}"` });
  }
  const updateFields = (noteId, fields) => invoke('updateNoteFields', { note: { id: noteId, fields } });
  // Missing notes come back as empty objects; normalize them to null.
  async function notesInfo(ids) {
    const info = await invoke('notesInfo', { notes: ids });
    return (info ?? []).map(n => (n && Number.isSafeInteger(n.noteId) ? n : null));
  }
  const addTags = (noteIds, tags) => invoke('addTags', { notes: noteIds, tags: tags.join(' ') });
  const addNote = (deckName, fields, tags) => invoke('addNote', { note: { deckName, modelName: MODEL_NAME, fields, tags, options: { allowDuplicate: true } } });
  // Struggling LearnHarness cards: tagged leech, or lapses >= threshold.
  async function struggles(minLapses) {
    if (!Number.isSafeInteger(minLapses) || minLapses < 1) throw new AnkiError('Invalid lapse threshold.');
    const names = await invoke('modelNames');
    if (!names.includes(MODEL_NAME)) return [];
    const [leeches, lapsing] = await Promise.all([
      invoke('findCards', { query: `"note:${MODEL_NAME}" tag:leech` }),
      invoke('findCards', { query: `"note:${MODEL_NAME}" prop:lapses>=${minLapses}` }),
    ]);
    const leechSet = new Set(leeches);
    const ids = [...new Set([...leeches, ...lapsing])];
    if (!ids.length) return [];
    const info = await invoke('cardsInfo', { cards: ids });
    return info.map(card => ({ cardId: card.cardId, noteId: card.note, lhId: card.fields?.LHId?.value ?? '', lapses: card.lapses ?? 0, leech: leechSet.has(card.cardId), deck: card.deckName }));
  }
  return { invoke, version, ensureModel, ensureDeck, findByLhId, notesInfo, updateFields, addTags, addNote, struggles };
}

module.exports = { createClient, AnkiError, MODEL_NAME, FIELDS, TEMPLATES, CSS, LEGACY };

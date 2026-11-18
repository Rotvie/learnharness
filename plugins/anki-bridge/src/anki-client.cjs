'use strict';
// Minimal AnkiConnect client (protocol version 6). Runs in the backend (Node),
// so AnkiConnect's browser CORS allowlist does not apply.

const MODEL_NAME = 'LearnHarness';
const FIELDS = ['Question', 'Answer', 'Proposition', 'Source', 'LHId'];
const CSS = `.card { font-family: system-ui, sans-serif; font-size: 20px; text-align: center; color: black; background-color: white; }
.nightMode .card, .card.nightMode { color: #eee; background-color: #1e1e1e; }
.lh-question, .lh-answer { text-align: left; display: inline-block; max-width: 40em; }
.lh-context { margin-top: 1.5em; font-size: 14px; opacity: .65; }
pre { text-align: left; overflow-x: auto; padding: .6em; border-radius: 6px; background: rgba(127,127,127,.12); }
table { border-collapse: collapse; margin: 0 auto; } td, th { border: 1px solid rgba(127,127,127,.4); padding: .25em .5em; }`;
const TEMPLATES = [{
  Name: 'Recall',
  Front: '<div class="lh-question">{{Question}}</div>',
  Back: '{{FrontSide}}\n<hr id="answer">\n<div class="lh-answer">{{Answer}}</div>\n<div class="lh-context">{{Proposition}}<br>{{Source}}</div>',
}];

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
  async function ensureModel() {
    const names = await invoke('modelNames');
    if (!names.includes(MODEL_NAME)) {
      await invoke('createModel', { modelName: MODEL_NAME, inOrderFields: FIELDS, css: CSS, isCloze: false, cardTemplates: TEMPLATES });
      return { created: true };
    }
    const fields = await invoke('modelFieldNames', { modelName: MODEL_NAME });
    const missing = FIELDS.filter(f => !fields.includes(f));
    if (missing.length) throw new AnkiError(`The Anki note type "${MODEL_NAME}" exists but lacks fields: ${missing.join(', ')}. Rename that note type in Anki so Anki Bridge can create its own.`);
    return { created: false };
  }
  const ensureDeck = name => invoke('createDeck', { deck: name });
  async function findByLhId(id) {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new AnkiError('Invalid card identity.');
    return invoke('findNotes', { query: `"note:${MODEL_NAME}" "LHId:${id}"` });
  }
  const updateFields = (noteId, fields) => invoke('updateNoteFields', { note: { id: noteId, fields } });
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
  return { invoke, version, ensureModel, ensureDeck, findByLhId, updateFields, addNote, struggles };
}

module.exports = { createClient, AnkiError, MODEL_NAME, FIELDS, TEMPLATES, CSS };

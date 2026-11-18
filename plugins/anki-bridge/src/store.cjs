'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function atomicWrite(file, content) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

const defaults = () => ({ ankiUrl: 'http://127.0.0.1:8765', apiKey: '', rootDeck: 'LearnHarness', chunkBudget: 4000, modelOverride: null, struggleLapses: 3 });

// cards: { [id]: { id, propositionId, propositionName, sourceId, sourceTitle,
//   question, answer, createdAt, updatedAt, ankiNoteId, pushedHash, pushedAt } }
function openStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'anki-bridge.json');
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read Anki Bridge data: ${error.message}`);
    state = { version: 1, revision: 0, settings: defaults(), cards: {}, batches: [] };
  }
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || !state.cards || typeof state.cards !== 'object' || !Array.isArray(state.batches) || !state.settings) throw new Error('Unsupported or invalid Anki Bridge data. No data was changed.');
  state.settings = { ...defaults(), ...state.settings };
  return {
    get: () => state,
    change(update) {
      const next = structuredClone(state);
      const result = update(next);
      next.revision++;
      atomicWrite(file, JSON.stringify(next));
      state = next;
      return result;
    },
  };
}
module.exports = { openStore, defaults };

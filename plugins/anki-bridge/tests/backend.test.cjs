'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { activate, validateSettings } = require('../src/backend.cjs');
const { defaults } = require('../src/store.cjs');

const flush = () => new Promise(resolve => setImmediate(resolve));
const node = (id, source = 'source') => ({ id, name: `Fact ${id}`, statement: `Statement ${id}`, provenance: [{ chatId: source }] });
const graph = (...ids) => ({ propositions: ids.map(id => node(id)), chains: [], sessions: { source: 'Source lesson' }, fileSources: {} });
const q = text => `Topic: ${text}`;
const cards = (id, ...questions) => ({ propositionId: id, cards: questions.map(question => ({ question: q(question), answer: `Answer to ${question}` })) });

// Minimal durable worker service; no model execution.
function workerService() {
  const tasks = new Map(), waiters = new Map(), definitions = new Map();
  const terminal = task => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(task.status);
  return {
    service: {
      register(value) { definitions.set(value.id, value); return () => {}; },
      start(workerId, options) {
        assert.ok(definitions.has(workerId)); assert.equal(options.purpose, 'user');
        const prior = [...tasks.values()].find(task => task.requestId === options.requestId);
        if (prior) return structuredClone(prior);
        const task = { id: randomUUID(), workerId, requestId: options.requestId, input: structuredClone(options.input), status: 'running', turns: 0, activity: 'waiting' };
        tasks.set(task.id, task); return structuredClone(task);
      },
      list: () => structuredClone([...tasks.values()]),
      get: id => structuredClone(tasks.get(id)),
      subscribe: () => () => {},
      wait(id, signal) {
        if (terminal(tasks.get(id))) return Promise.resolve();
        return new Promise((resolve, reject) => {
          const set = waiters.get(id) ?? new Set(); waiters.set(id, set); set.add(resolve);
          signal.addEventListener('abort', () => reject(new Error('disposed')), { once: true });
        });
      },
      cancel(id) { tasks.get(id).cancelRequested = true; },
    },
    complete(id, value, status = 'succeeded') {
      const task = tasks.get(id);
      if (status === 'succeeded') definitions.get(task.workerId).validateResult(value, { input: task.input });
      task.status = status; if (status === 'succeeded') task.result = structuredClone(value);
      for (const done of waiters.get(id) ?? []) done();
    },
    validate(value, input) { definitions.get('generate-anki-cards-v1').validateResult(value, { input }); },
  };
}

// In-memory AnkiConnect speaking protocol v6 over a fake fetch.
function fakeAnki() {
  const anki = { up: true, models: {}, decks: new Set(['Default']), notes: new Map(), nextId: 1000, calls: [], key: null };
  anki.fetch = async (url, init) => {
    if (!anki.up) { const error = new TypeError('fetch failed'); error.cause = { code: 'ECONNREFUSED' }; throw error; }
    const { action, version, params, key } = JSON.parse(init.body);
    anki.calls.push(action);
    assert.equal(version, 6);
    const reply = (result, error = null) => ({ ok: true, status: 200, json: async () => ({ result, error }) });
    if (anki.key && key !== anki.key) return reply(null, 'valid api key must be provided');
    switch (action) {
      case 'version': return reply(6);
      case 'deckNames': return reply([...anki.decks]);
      case 'modelNames': return reply(Object.keys(anki.models));
      case 'modelFieldNames': return reply(anki.models[params.modelName]?.fields ?? null, anki.models[params.modelName] ? null : 'model was not found');
      case 'createModel': anki.models[params.modelName] = { fields: params.inOrderFields, css: params.css, templates: Object.fromEntries(params.cardTemplates.map(t => [t.Name, { Front: t.Front, Back: t.Back }])) }; return reply({});
      case 'modelTemplates': return reply(structuredClone(anki.models[params.modelName].templates));
      case 'modelStyling': return reply({ css: anki.models[params.modelName].css });
      case 'updateModelTemplates': Object.assign(anki.models[params.model.name].templates, structuredClone(params.model.templates)); return reply(null);
      case 'updateModelStyling': anki.models[params.model.name].css = params.model.css; return reply(null);
      case 'notesInfo': return reply(params.notes.map(id => { const n = anki.notes.get(id); return n ? { noteId: id, modelName: n.modelName, tags: [...n.tags], fields: Object.fromEntries(Object.entries(n.fields).map(([k, v], order) => [k, { value: v, order }])) } : {}; }));
      case 'addTags': for (const id of params.notes) { const n = anki.notes.get(id); for (const tag of params.tags.split(' ')) if (!n.tags.includes(tag)) n.tags.push(tag); } return reply(null);
      case 'createDeck': anki.decks.add(params.deck); return reply(1);
      case 'findCards': {
        // Card id == note id in this fake; one card per note.
        const lapses = /prop:lapses>=(\d+)/.exec(params.query), leech = /tag:leech/.test(params.query);
        const hits = [...anki.notes].filter(([, n]) => n.modelName === 'LearnHarness' && (leech ? (n.tags ?? []).includes('leech') : true) && (lapses ? (n.lapses ?? 0) >= Number(lapses[1]) : true));
        return reply(hits.map(([id]) => id));
      }
      case 'cardsInfo': return reply(params.cards.map(id => { const n = anki.notes.get(id); return { cardId: id, note: id, deckName: n.deckName, lapses: n.lapses ?? 0, fields: Object.fromEntries(Object.entries(n.fields).map(([k, v], order) => [k, { value: v, order }])) }; }));
      case 'findNotes': {
        const id = /"LHId:([^"]+)"/.exec(params.query)[1];
        return reply([...anki.notes].filter(([, n]) => n.modelName === 'LearnHarness' && n.fields.LHId === id).map(([noteId]) => noteId));
      }
      case 'addNote': {
        assert.ok(anki.decks.has(params.note.deckName), 'deck must exist');
        assert.ok(anki.models[params.note.modelName], 'model must exist');
        const id = anki.nextId++; anki.notes.set(id, structuredClone(params.note)); return reply(id);
      }
      case 'updateNoteFields': {
        const note = anki.notes.get(params.note.id);
        if (!note) return reply(null, 'note was not found');
        Object.assign(note.fields, params.note.fields); note.updates = (note.updates ?? 0) + 1; return reply(null);
      }
      default: return reply(null, `unsupported action ${action}`);
    }
  };
  return anki;
}

function harness(t, initialGraph = graph('p1')) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'anki-bridge-test-'));
  const workers = workerService(), anki = fakeAnki();
  const h = { graph: initialGraph, workers, anki, directory, catalog: {
    slots: { cheap: { model: { provider: 'mock', id: 'cheap' }, thinkingLevel: 'off' } },
    models: [{ provider: 'mock', id: 'cheap', name: 'Mock cheap', supportedLevels: ['off', 'low'], contextWindow: 100000, maxTokens: 8192 }],
  } };
  let handlers, controller, cleanups = [];
  h.dispose = () => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); controller?.abort(); };
  h.activate = () => {
    h.dispose(); handlers = new Map(); controller = new AbortController(); h.instructions = []; h.tools = [];
    activate({ dataDirectory: directory, signal: controller.signal, workers: workers.service, learning: { graph: () => structuredClone(h.graph) },
      inference: { catalog: async () => structuredClone(h.catalog) }, events: { emit() {} },
      handle: (name, handler) => handlers.set(name, handler), cleanup: fn => cleanups.push(fn),
      registerInstructions: value => { h.instructions.push(value); return () => { h.instructions = h.instructions.filter(x => x !== value); }; },
      registerTools: value => { h.tools.push(value); return () => { h.tools = h.tools.filter(x => x !== value); }; } }, { fetch: anki.fetch });
  };
  h.call = async (name, input = {}) => { assert.ok(handlers.has(name), name); return handlers.get(name)(input); };
  h.state = () => handlers.get('get-state')({});
  h.generate = async (...rows) => {
    const plan = await h.call('preflight', { propositionIds: rows.map(r => r.propositionId) });
    await h.call('start-generation', { preflightId: plan.id, requestId: randomUUID() }); await flush();
    for (const chunk of h.state().batch.chunks) {
      const task = workers.service.list().find(x => x.requestId === chunk.requestId);
      workers.complete(task.id, { propositions: rows.filter(r => task.input.targets.includes(r.propositionId)) });
      await flush();
    }
    return h.state();
  };
  h.activate();
  t.after(() => { h.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return h;
}

test('generation stores cards per source; push creates note type, deck and tagged notes', async t => {
  const h = harness(t, graph('p1', 'p2'));
  const state = await h.generate(cards('p1', 'What is $x^2$?'), cards('p2', 'Second?'));
  assert.equal(state.cards.length, 2);
  assert.equal(state.deck, 'LearnHarness');
  assert.ok(state.cards.every(c => c.status === 'new' && c.tag === 'learnharness::Source_lesson'));
  const { summary, state: after } = await h.call('push');
  assert.deepEqual({ created: summary.created, updated: summary.updated, conflicts: summary.conflicts, failed: summary.failed }, { created: 2, updated: 0, conflicts: 0, failed: [] });
  assert.deepEqual(h.anki.models.LearnHarness.fields, ['Question', 'Answer', 'Proposition', 'Source', 'LHId']);
  assert.match(h.anki.models.LearnHarness.templates.Recall.Back, /\{\{#Proposition\}\}/);
  assert.doesNotMatch(h.anki.models.LearnHarness.css, /background-color|color: black/);
  assert.deepEqual([...h.anki.decks].sort(), ['Default', 'LearnHarness']);
  const note = [...h.anki.notes.values()].find(n => n.fields.Question.includes('x^2'));
  assert.equal(note.deckName, 'LearnHarness');
  assert.equal(note.fields.Question, 'Topic: What is \\(x^2\\)?');
  assert.equal(note.fields.Proposition, 'Fact p1');
  assert.equal(note.fields.Source, 'Source lesson');
  assert.deepEqual(note.tags, ['learnharness', 'learnharness::Source_lesson']);
  assert.ok(after.cards.every(c => c.status === 'pushed' && c.ankiNoteId));
});

test('re-push updates edited notes in place and skips unchanged ones', async t => {
  const h = harness(t);
  const state = await h.generate(cards('p1', 'One?', 'Two?'));
  await h.call('push');
  const edited = state.cards.find(c => c.question === q('One?'));
  const view = await h.call('save-card', { id: edited.id, question: 'One, revised?', answer: 'Yes' });
  assert.equal(view.cards.find(c => c.id === edited.id).status, 'changed');
  h.anki.calls.length = 0;
  const { summary } = await h.call('push');
  assert.deepEqual({ created: summary.created, updated: summary.updated, attempted: summary.attempted }, { created: 0, updated: 1, attempted: 1 });
  assert.equal(h.anki.notes.size, 2);
  const note = [...h.anki.notes.values()].find(n => n.fields.LHId === edited.id);
  assert.equal(note.fields.Question, 'One, revised?'); assert.equal(note.updates, 1);
  assert.ok(!h.anki.calls.includes('addNote'));
});

test('a note deleted in Anki is recreated on the next push of that card', async t => {
  const h = harness(t);
  const state = await h.generate(cards('p1', 'Gone?'));
  await h.call('push');
  h.anki.notes.clear();
  await h.call('save-card', { id: state.cards[0].id, question: 'Gone?', answer: 'Changed answer' });
  const { summary } = await h.call('push');
  assert.equal(summary.created, 1); assert.equal(h.anki.notes.size, 1);
});

test('unreachable Anki reports a clear error and leaves cards unpushed', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Q?'));
  h.anki.up = false;
  await assert.rejects(h.call('push'), /Anki not reachable/);
  assert.equal(h.state().cards[0].status, 'new');
  assert.match(h.state().lastPush.error, /Anki not reachable/);
  await assert.rejects(h.call('test-connection'), /Anki not reachable/);
  h.anki.up = true;
  assert.deepEqual(await h.call('test-connection'), { ok: true, version: 6, deckCount: 1 });
});

test('API key is sent when configured', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Q?'));
  h.anki.key = 'secret';
  await assert.rejects(h.call('push'), /valid api key/);
  await h.call('save-settings', { apiKey: 'secret' });
  const { summary } = await h.call('push');
  assert.equal(summary.created, 1);
});

test('existing LearnHarness note type with wrong fields is refused', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Q?'));
  h.anki.models.LearnHarness = { fields: ['Front', 'Back'], templates: {}, css: '' };
  await assert.rejects(h.call('push'), /lacks fields: Question, Answer, Proposition, Source, LHId/);
});

test('deck setting picks an existing deck (no subdecks); list-decks; deleting a card is local only', async t => {
  const h = harness(t);
  const state = await h.generate(cards('p1', 'Q?'));
  h.anki.decks.add('Obsidian');
  assert.deepEqual(await h.call('list-decks'), ['Default', 'Obsidian']);
  await h.call('save-settings', { deck: ' Obsidian ' });
  h.anki.calls.length = 0;
  await h.call('push');
  assert.deepEqual([...h.anki.decks].sort(), ['Default', 'Obsidian']);
  assert.equal([...h.anki.notes.values()][0].deckName, 'Obsidian');
  await h.call('delete-card', { id: state.cards[0].id });
  assert.equal(h.state().cards.length, 0); assert.equal(h.anki.notes.size, 1);
});

test('worker results reject Mermaid and duplicate questions', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Existing?'));
  const input = { targets: ['p1'], cards: [{ propositionId: 'p1', active: [{ question: 'Existing?', answer: 'x' }] }] };
  assert.throws(() => h.workers.validate({ propositions: [cards('p1', 'Existing?')] }, { ...input, cards: [{ propositionId: 'p1', active: [{ question: q('Existing?'), answer: 'x' }] }] }), /Duplicate question/);
  assert.throws(() => h.workers.validate({ propositions: [{ propositionId: 'p1', cards: [{ question: q('Draw'), answer: '```mermaid\ngraph LR\n```' }] }] }, input), /Mermaid/);
});

test('worker results reject answers over 300 characters but accept 300', async t => {
  const h = harness(t);
  const input = { targets: ['p1'], cards: [{ propositionId: 'p1', active: [] }] };
  const row = answer => ({ propositions: [{ propositionId: 'p1', cards: [{ question: q('Q?'), answer }] }] });
  assert.throws(() => h.workers.validate(row('x'.repeat(301)), input), /Answer too long .*301 > 300.*minimum information/);
  assert.doesNotThrow(() => h.workers.validate(row('x'.repeat(300)), input));
});

test('prompt includes the formulation rules section', () => {
  const { instructions } = require('../src/generation-prompts.cjs');
  assert.match(instructions, /## Formulation rules \(SuperMemo/);
  assert.match(instructions, /No sets \(rule 9\)/);
  assert.match(instructions, /\$a\*b \\in G\$/);
  assert.ok(instructions.indexOf('## Card writing') < instructions.indexOf('## Formulation rules'));
});

test('settings validation', () => {
  assert.throws(() => validateSettings({ ankiUrl: 'ftp://x' }, defaults()), /http or https/);
  assert.throws(() => validateSettings({ ankiUrl: 'not a url' }, defaults()), /valid AnkiConnect URL/);
  assert.throws(() => validateSettings({ deck: ' :: ' }, defaults()), /Anki deck must not be blank/);
  assert.throws(() => validateSettings({ rootDeck: 'X' }, defaults()), /Unsupported setting/);
  assert.equal(validateSettings({ deck: 'Study :: LH' }, defaults()).deck, 'Study::LH');
  assert.throws(() => validateSettings({ other: 1 }, defaults()), /Unsupported setting/);
  assert.equal(validateSettings({ ankiUrl: ' http://localhost:8765 ' }, defaults()).ankiUrl, 'http://localhost:8765');
});

test('cards survive reactivation', async t => {
  const h = harness(t);
  await h.generate(cards('p1', 'Persist?'));
  h.activate();
  assert.equal(h.state().cards.length, 1);
});

test('struggles: leech or lapses >= threshold, grouped per proposition, most severe first', async t => {
  const h = harness(t, graph('p1', 'p2', 'p3'));
  await h.generate(cards('p1', 'A1?', 'A2?'), cards('p2', 'B1?'), cards('p3', 'C1?'));
  await h.call('push');
  const note = question => [...h.anki.notes.values()].find(n => n.fields.Question === `Topic: ${question}`);
  note('A1?').lapses = 3; note('A2?').lapses = 1;      // p1: one card at threshold
  note('B1?').lapses = 1; note('B1?').tags.push('leech'); // p2: leech below threshold
  note('C1?').lapses = 2;                               // p3: below threshold, not leech
  const result = await h.call('get-struggles');
  assert.equal(result.threshold, 3);
  assert.deepEqual(result.propositions.map(p => [p.propositionId, p.lapses, p.leech]), [['p2', 1, true], ['p1', 3, false]]);
  assert.equal(result.propositions[1].statement, 'Statement p1');
  assert.deepEqual(result.propositions[1].cards.map(c => c.question), ['Topic: A1?']);
  await h.call('save-settings', { struggleLapses: 2 });
  assert.deepEqual((await h.call('get-struggles')).propositions.map(p => p.propositionId).sort(), ['p1', 'p2', 'p3']);
  assert.throws(() => require('../src/backend.cjs').validateSettings({ struggleLapses: 0 }, require('../src/store.cjs').defaults()), /1 to 100/);
});

test('struggles ignore notes without an Anki Bridge card and report no LearnHarness note type', async t => {
  const h = harness(t);
  assert.deepEqual((await h.call('get-struggles')).propositions, []); // note type missing
  await h.generate(cards('p1', 'Q?'));
  await h.call('push');
  h.anki.notes.set(9999, { modelName: 'LearnHarness', deckName: 'X', tags: ['leech'], lapses: 9, fields: { LHId: 'unknown-id', Question: 'Topic: other' } });
  assert.deepEqual((await h.call('get-struggles')).propositions, []);
});

test('practice-only tool and instruction; tool reports struggles and survives Anki being down', async t => {
  const h = harness(t);
  assert.deepEqual(h.instructions.map(i => i.agents), [['practice']]);
  assert.match(h.instructions[0].text, /anki_struggles/);
  assert.deepEqual(h.tools.map(x => x.agents), [['practice']]);
  const [tool] = h.tools[0].create({ chatId: 'c1', agent: 'practice' });
  assert.equal(tool.name, 'anki_struggles');
  const signal = new AbortController().signal;
  await h.generate(cards('p1', 'Q?'));
  await h.call('push');
  let out = await tool.execute('t1', {}, signal);
  assert.match(out.content[0].text, /No struggling propositions/);
  [...h.anki.notes.values()][0].lapses = 5;
  out = await tool.execute('t2', { limit: 5 }, signal);
  assert.match(out.content[0].text, /1\. Fact p1 \[id p1\] — 5 lapses\n   Statement: Statement p1/);
  h.anki.up = false;
  out = await tool.execute('t3', {}, signal);
  assert.equal(out.details.available, false);
  assert.match(out.content[0].text, /Anki struggle data unavailable: Anki not reachable.*Continue practice/);
});

test('generation rejects cards breaking the formulation checks', async t => {
  const h = harness(t);
  const input = { targets: ['p1'], cards: [{ propositionId: 'p1', active: [] }] };
  const one = (question, answer) => ({ propositions: [{ propositionId: 'p1', cards: [{ question, answer }] }] });
  assert.throws(() => h.workers.validate(one('What is closure?', 'x'), input), /rejected .*topic prefix/);
  assert.throws(() => h.workers.validate(one('Groups: axioms?', 'closure, associativity, identity and inverses'), input), /enumerates/);
  assert.doesNotThrow(() => h.workers.validate(one('Groups: axiom guaranteeing $a*b \\in G$?', 'closure'), input));
});

// Pushes p1's single card, then returns its Anki note.
async function pushedNote(h, question = 'Q?') {
  const state = await h.generate(cards('p1', question));
  await h.call('push');
  return { card: state.cards[0], note: [...h.anki.notes.values()][0], noteId: [...h.anki.notes.keys()][0] };
}

test('legacy rootDeck setting migrates to deck', async t => {
  const h = harness(t);
  const file = path.join(h.directory, 'anki-bridge.json');
  const { deck, ...settings } = defaults();
  fs.writeFileSync(file, JSON.stringify({ version: 1, revision: 3, settings: { ...settings, rootDeck: 'Obsidian' }, cards: {}, batches: [] }));
  h.activate();
  assert.equal(h.state().settings.deck, 'Obsidian');
  assert.ok(!('rootDeck' in h.state().settings));
});

test('an untouched legacy note type is upgraded; a customized one is left with a notice', async t => {
  const { LEGACY } = require('../src/anki-client.cjs');
  const h = harness(t);
  await h.generate(cards('p1', 'Q?'));
  const legacy = () => ({ fields: ['Question', 'Answer', 'Proposition', 'Source', 'LHId'], css: LEGACY[0].css, templates: { Recall: { Front: LEGACY[0].Front, Back: LEGACY[0].Back } } });
  h.anki.models.LearnHarness = legacy();
  let { summary } = await h.call('push');
  assert.equal(summary.notice, null);
  assert.equal(h.anki.models.LearnHarness.templates.Recall.Front, '<div class="lh-q">{{Question}}</div>');
  assert.doesNotMatch(h.anki.models.LearnHarness.css, /color: black/);

  await h.generate(cards('p1', 'Q2?'));
  h.anki.models.LearnHarness = legacy();
  h.anki.models.LearnHarness.css += '\n.card { font-size: 30px; }';
  h.anki.calls.length = 0;
  ({ summary } = await h.call('push'));
  assert.match(summary.notice, /customized in Anki/);
  assert.match(h.anki.models.LearnHarness.css, /30px/);
  assert.equal(h.anki.models.LearnHarness.templates.Recall.Front, LEGACY[0].Front);
  assert.ok(!h.anki.calls.includes('updateModelTemplates') && !h.anki.calls.includes('updateModelStyling'));
  assert.equal(summary.created, 1);
});

test('updating a legacy note adds the source tag without moving it', async t => {
  const h = harness(t);
  const { card, note } = await pushedNote(h);
  note.tags = ['learnharness', 'mine']; note.deckName = 'LearnHarness::Source lesson';
  await h.call('save-card', { id: card.id, question: q('Q, revised?'), answer: 'A' });
  await h.call('push');
  assert.deepEqual(note.tags, ['learnharness', 'mine', 'learnharness::Source_lesson']);
  assert.equal(note.deckName, 'LearnHarness::Source lesson');
});

test('a note edited in Anki is not overwritten: conflict, then keep Anki version', async t => {
  const h = harness(t);
  const { card, note } = await pushedNote(h);
  note.fields.Answer = 'Edited <b>in Anki</b>';
  await h.call('save-card', { id: card.id, question: card.question, answer: 'Local edit' });
  const { summary, state } = await h.call('push');
  assert.deepEqual({ conflicts: summary.conflicts, updated: summary.updated }, { conflicts: 1, updated: 0 });
  assert.equal(note.fields.Answer, 'Edited <b>in Anki</b>');
  const conflicted = state.cards[0];
  assert.equal(conflicted.status, 'conflict');
  assert.equal(conflicted.conflict.answer, 'Edited <b>in Anki</b>');
  assert.equal((await h.call('push')).summary.attempted, 0); // conflicts wait for a decision

  const kept = await h.call('resolve-conflict', { id: card.id, keep: 'anki' });
  assert.equal(kept.state.cards[0].status, 'pushed');
  assert.equal(note.fields.Answer, 'Edited <b>in Anki</b>');
  // A later local edit is pushed normally: Anki has not changed since it was kept.
  await h.call('save-card', { id: card.id, question: card.question, answer: 'Second local edit' });
  const again = await h.call('push');
  assert.equal(again.summary.updated, 1);
  assert.equal(note.fields.Answer, 'Second local edit');
});

test('conflict resolved by overwriting Anki', async t => {
  const h = harness(t);
  const { card, note } = await pushedNote(h);
  note.fields.Question = 'Anki wording';
  await h.call('save-card', { id: card.id, question: q('Local wording?'), answer: 'A' });
  await h.call('push');
  await assert.rejects(h.call('resolve-conflict', { id: card.id, keep: 'both' }), /Choose which version/);
  const { summary, state } = await h.call('resolve-conflict', { id: card.id, keep: 'local' });
  assert.equal(summary.updated, 1);
  assert.equal(note.fields.Question, 'Topic: Local wording?');
  assert.equal(state.cards[0].status, 'pushed');
  await assert.rejects(h.call('resolve-conflict', { id: card.id, keep: 'local' }), /no conflict/);
});

test('unicode normalization by Anki is not mistaken for an edit', async t => {
  const h = harness(t);
  const { card, note } = await pushedNote(h, 'カ\u3099?'); // decomposed ガ
  note.fields.Question = note.fields.Question.normalize('NFC');
  await h.call('save-card', { id: card.id, question: card.question, answer: 'New' });
  const { summary } = await h.call('push');
  assert.deepEqual({ conflicts: summary.conflicts, updated: summary.updated }, { conflicts: 0, updated: 1 });
});

test('a note whose LHId was damaged is found by its note ID and repaired', async t => {
  const h = harness(t);
  const { card, note, noteId } = await pushedNote(h);
  note.fields.LHId = 'oops';
  await h.call('save-card', { id: card.id, question: q('Revised?'), answer: 'A' });
  const { summary } = await h.call('push');
  assert.deepEqual({ created: summary.created, updated: summary.updated, conflicts: summary.conflicts }, { created: 0, updated: 1, conflicts: 0 });
  assert.equal(h.anki.notes.size, 1);
  assert.equal(h.anki.notes.get(noteId).fields.LHId, card.id);
});

test('a stored note ID now holding another note type is not reused', async t => {
  const h = harness(t);
  const { card, note } = await pushedNote(h);
  note.modelName = 'Basic';
  await h.call('save-card', { id: card.id, question: q('Revised?'), answer: 'A' });
  const { summary } = await h.call('push');
  assert.equal(summary.created, 1);
  assert.equal(h.anki.notes.size, 2);
});

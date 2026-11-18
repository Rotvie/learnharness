'use strict';
const { randomUUID, createHash } = require('node:crypto');
const path = require('node:path');
const { openStore } = require('./store.cjs');
const { instructions, promptFor } = require('./generation-prompts.cjs');
const { toAnkiHtml, deckName, escapeHtml } = require('./format.cjs');
const { createClient } = require('./anki-client.cjs');
const { checkCard } = require('./card-checks.cjs');

const WORKER_ID = 'generate-anki-cards-v1';
const resultSchema = {
  type: 'object', additionalProperties: false, required: ['propositions'], properties: {
    propositions: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['propositionId', 'cards'], properties: {
      propositionId: { type: 'string', minLength: 1 }, cards: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['question', 'answer'], properties: { question: { type: 'string', minLength: 1 }, answer: { type: 'string', minLength: 1 } } } },
    } } },
  },
};
// Enforces the minimum information principle (SuperMemo rule 4) rather than only asking for it.
const MAX_ANSWER_CHARS = 300;
const TERMINAL =['applied', 'failed', 'cancelled', 'interrupted'];
const estimate = input => Math.ceil(Buffer.byteLength(instructions + JSON.stringify(resultSchema) + promptFor(input), 'utf8') / 3) + 256;
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const activeBatch = s => s.batches.findLast(b => ['running', 'cancelling'].includes(b.status));
const fail = message => { throw new Error(message); };
function requiredText(value, label) { if (typeof value !== 'string' || !value.trim()) fail(`${label} must not be blank.`); return value; }

function validateSettings(patch, old) {
  const allowed = new Set(['ankiUrl', 'apiKey', 'rootDeck', 'chunkBudget', 'modelOverride', 'thinkingOverride', 'struggleLapses']);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) fail(`Unsupported setting: ${key}`);
  const s = { ...old, ...patch };
  if (s.thinkingOverride === null) delete s.thinkingOverride;
  let url;
  try { url = new URL(String(s.ankiUrl).trim()); } catch { fail('Enter a valid AnkiConnect URL, for example http://127.0.0.1:8765.'); }
  if (!['http:', 'https:'].includes(url.protocol)) fail('AnkiConnect URL must use http or https.');
  s.ankiUrl = String(s.ankiUrl).trim();
  if (typeof s.apiKey !== 'string') fail('API key must be text.');
  s.apiKey = s.apiKey.trim();
  if (typeof s.rootDeck !== 'string' || !s.rootDeck.replace(/:/g, '').trim()) fail('Root deck must not be blank.');
  s.rootDeck = s.rootDeck.trim();
  if (!Number.isSafeInteger(s.chunkBudget) || s.chunkBudget < 1) fail('Input budget must be a positive safe whole number.');
  if (!Number.isSafeInteger(s.struggleLapses) || s.struggleLapses < 1 || s.struggleLapses > 100) fail('Struggle lapse threshold must be a whole number from 1 to 100.');
  if (s.modelOverride !== null && (!s.modelOverride || typeof s.modelOverride.provider !== 'string' || typeof s.modelOverride.id !== 'string')) fail('Invalid model override.');
  if (s.thinkingOverride !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(s.thinkingOverride)) fail('Invalid thinking level.');
  return s;
}

function validateResult(result, context) {
  const input = context.input;
  if (!result || !Array.isArray(result.propositions)) fail('Return a propositions array.');
  const remaining = new Set(input.targets);
  for (const row of result.propositions) {
    if (!remaining.delete(row.propositionId)) fail(`Unknown or repeated target: ${row.propositionId}`);
    if (!Array.isArray(row.cards)) fail('Each target needs a cards array.');
    const known = input.cards.find(c => c.propositionId === row.propositionId);
    const questions = new Set((known?.active ?? []).map(c => c.question.trim()));
    for (const card of row.cards) {
      requiredText(card.question, 'Question'); requiredText(card.answer, 'Answer');
      if (card.answer.trim().length > MAX_ANSWER_CHARS) fail(`Answer too long for ${row.propositionId} (${card.answer.trim().length} > ${MAX_ANSWER_CHARS} characters): give the bare fact (minimum information principle), or split it into separate cards.`);
      const rule = checkCard(card);
      if (rule) fail(`Card for ${row.propositionId} rejected ("${card.question.slice(0, 60)}"): ${rule}`);
      if (/```\s*mermaid/i.test(card.question + card.answer)) fail(`Mermaid diagrams cannot render in Anki (${row.propositionId}); express the card as text or math.`);
      if (questions.has(card.question.trim())) fail(`Duplicate question for ${row.propositionId}; propose a distinct missing cue.`);
      questions.add(card.question.trim());
    }
  }
  if (remaining.size) fail(`Missing targets: ${[...remaining].join(', ')}`);
}

function sourceOf(graph, node) {
  const sourceId = node.provenance?.[0]?.chatId;
  if (!sourceId) fail(`No birth source is recorded for ${node.name}.`);
  const title = graph.sessions?.[sourceId] ?? (graph.fileSources?.[sourceId] ? path.basename(graph.fileSources[sourceId]) : sourceId);
  return { sourceId, title };
}

function pack(graph, ids, state) {
  const nodes = new Map(graph.propositions.map(n => [n.id, n]));
  const targets = [...new Set(ids)];
  if (!targets.length) fail('Select at least one proposition.');
  for (const id of targets) if (!nodes.has(id)) fail(`Selected proposition is no longer in the graph: ${id}`);
  const existing = Object.values(state.cards);
  function assemble(selected) {
    const selectedSet = new Set(selected);
    const chains = graph.chains.filter(c => selectedSet.has(c.conclusion) || c.premises.some(id => selectedSet.has(id)));
    const needed = new Set([...selected, ...chains.flatMap(c => [...c.premises, c.conclusion])]);
    const propositions = [...needed].map(id => {
      const n = nodes.get(id); if (!n) fail(`Incomplete reasoning chain: ${id}`);
      return { id, name: n.name, statement: n.statement };
    });
    const sources = selected.map(id => { const node = nodes.get(id), source = sourceOf(graph, node); return { propositionId: id, sourceId: source.sourceId, title: source.title, name: node.name }; });
    const cards = selected.map(id => ({ propositionId: id, active: existing.filter(c => c.propositionId === id).map(({ question, answer }) => ({ question, answer })) }));
    return { targets: selected, propositions, chains: chains.map(({ id, premises, conclusion }) => ({ id, premises, conclusion })), cards, sources };
  }
  const chunks = []; let current = [], currentTokens = 0;
  for (const id of targets) {
    const node = nodes.get(id), tokens = Math.ceil(`${node.name}\n${node.statement}`.length / 4);
    if (current.length && currentTokens + tokens > state.settings.chunkBudget) { chunks.push(assemble(current)); current = []; currentTokens = 0; }
    current.push(id); currentTokens += tokens;
  }
  if (current.length) chunks.push(assemble(current));
  return chunks;
}

// Exactly what Anki receives; the hash of these fields decides new/changed/pushed.
function ankiFields(card) {
  return { Question: toAnkiHtml(card.question), Answer: toAnkiHtml(card.answer), Proposition: escapeHtml(card.propositionName || ''), Source: escapeHtml(card.sourceTitle || ''), LHId: card.id };
}
function cardStatus(card) {
  if (!card.pushedHash) return 'new';
  try { return fingerprint(ankiFields(card)) === card.pushedHash ? 'pushed' : 'changed'; } catch { return 'changed'; }
}

const PRACTICE_INSTRUCTIONS = `Anki Bridge is enabled: the learner reviews flashcards for some LearnHarness
propositions in Anki. When choosing what to practice, you may call
anki_struggles to see propositions the learner keeps forgetting there.
Prefer problems that require those propositions to come to mind without
naming them. Treat lapses as a hint about weak recall, not proof of
misunderstanding. Mention Anki statistics only if the learner asks.`;

function formatStruggles(result, limit) {
  if (!result.propositions.length) return `No struggling propositions in Anki (threshold: leech tag or ${result.threshold}+ lapses).`;
  const rows = result.propositions.slice(0, limit).map((p, i) => {
    const flag = p.leech ? ', leech' : '';
    const statement = p.statement ? `\n   Statement: ${p.statement}` : '';
    const graph = p.inGraph ? '' : ' (no longer in the knowledge graph)';
    return `${i + 1}. ${p.name}${graph} [id ${p.propositionId}] — ${p.lapses} lapses${flag}${statement}`;
  });
  const more = result.propositions.length > limit ? `\n(${result.propositions.length - limit} more not shown)` : '';
  return `Propositions the learner keeps forgetting in Anki (leech tag or ${result.threshold}+ lapses), most severe first:\n${rows.join('\n')}${more}`;
}

function activate(ctx, options = {}) {
  if (!ctx.workers?.register || !ctx.learning?.graph) fail('This app build does not provide the plugin capabilities required by Anki Bridge.');
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const store = openStore(ctx.dataDirectory);
  const preflights = new Map(), observers = new Map(), applicationErrors = new Map();
  let disposed = false, pushing = null, lastPush = null;
  const alive = () => { if (disposed || ctx.signal.aborted) fail('Anki Bridge is disabled.'); };
  const notify = (topic = 'changed') => { if (!disposed && !ctx.signal.aborted) ctx.events.emit(topic); };
  function change(update, topic) { alive(); const result = store.change(update); notify(topic); return result; }
  function graphNow() { const g = ctx.learning.graph(); if (!Array.isArray(g.propositions) || !Array.isArray(g.chains)) fail('Could not read the knowledge graph.'); return g; }
  const client = () => { const s = store.get().settings; return createClient({ url: s.ankiUrl, apiKey: s.apiKey, fetchImpl }); };

  function view() {
    alive(); const s = store.get();
    const cards = Object.values(s.cards).sort((a, b) => a.createdAt - b.createdAt).map(c => ({ ...c, status: cardStatus(c), deck: deckName(s.settings.rootDeck, c.sourceTitle) }));
    const b = s.batches.at(-1);
    const batch = b ? { ...b, chunks: b.chunks.map(c => {
      if (applicationErrors.has(c.id)) return { ...c, error: applicationErrors.get(c.id) };
      if (['queued', 'running'].includes(c.status) && c.taskId) { try { const t = ctx.workers.get(c.taskId); return { ...c, status: t.status === 'succeeded' ? 'saving' : t.status }; } catch { /* keep durable status */ } }
      return c;
    }), added: b.chunks.reduce((n, c) => n + (c.added || 0), 0), completed: b.chunks.filter(c => TERMINAL.includes(c.status)).length, total: b.chunks.length,
      failedTargetIds: b.chunks.filter(c => ['failed', 'cancelled', 'interrupted'].includes(c.status)).flatMap(c => c.targetIds ?? []),
      error: b.chunks.map(c => applicationErrors.get(c.id)).find(Boolean) } : null;
    return { revision: s.revision, settings: s.settings, cards, batch, pushing: !!pushing, lastPush };
  }

  function finishBatch(s, b) {
    if (b.chunks.some(c => !TERMINAL.includes(c.status))) return;
    b.status = b.cancelRequested ? 'cancelled' : b.chunks.every(c => c.status === 'applied') ? 'completed' : b.chunks.every(c => c.status === 'interrupted') ? 'interrupted' : 'partial';
  }
  function applyOutcome(batchId, chunkId, task) {
    if (disposed || ctx.signal.aborted) return;
    try {
      change(s => {
        const b = s.batches.find(b => b.id === batchId), c = b?.chunks.find(c => c.id === chunkId);
        if (!c || TERMINAL.includes(c.status)) return;
        if (b.cancelRequested) { c.status = 'cancelled'; finishBatch(s, b); return; }
        if (task.status !== 'succeeded') { c.status = ['cancelled', 'interrupted'].includes(task.status) ? task.status : 'failed'; c.error = `Worker did not return a result (${task.error?.code || task.status}). Check Background agents for details.`; finishBatch(s, b); return; }
        let added = 0; const now = Date.now();
        for (const row of task.result.propositions) {
          const source = task.input.sources.find(x => x.propositionId === row.propositionId);
          const seen = new Set(Object.values(s.cards).filter(x => x.propositionId === row.propositionId).map(x => x.question.trim()));
          for (const card of row.cards) {
            const q = card.question.trim(); if (seen.has(q)) continue; seen.add(q);
            const id = randomUUID();
            s.cards[id] = { id, propositionId: row.propositionId, propositionName: source.name, sourceId: source.sourceId, sourceTitle: source.title, question: card.question, answer: card.answer, createdAt: now, updatedAt: now, ankiNoteId: null, pushedHash: null, pushedAt: null };
            added++;
          }
        }
        c.status = 'applied'; c.added = added; finishBatch(s, b);
      }, 'batch-changed');
      applicationErrors.delete(chunkId);
    } catch (error) { applicationErrors.set(chunkId, `Result could not be saved: ${error.message}`); notify('batch-changed'); }
  }
  function watch(batchId, chunkId, taskId) {
    if (observers.has(taskId)) return;
    let last = '';
    const unsubscribe = ctx.workers.subscribe(taskId, task => { const current = `${task.status}:${task.turns}:${task.activity}`; if (current !== last) { last = current; notify('batch-changed'); } });
    observers.set(taskId, unsubscribe);
    ctx.workers.wait(taskId, ctx.signal).then(() => {
      if (disposed || ctx.signal.aborted) return;
      applyOutcome(batchId, chunkId, ctx.workers.get(taskId));
      observers.get(taskId)?.(); observers.delete(taskId);
    }).catch(error => { if (!disposed && !ctx.signal.aborted) { applicationErrors.set(chunkId, error.message); notify('batch-changed'); } });
  }
  function reconcile() {
    alive(); const tasks = ctx.workers.list();
    for (const b of store.get().batches) for (const c of b.chunks) {
      if (TERMINAL.includes(c.status)) continue;
      const t = tasks.find(t => t.requestId === c.requestId);
      if (!t) {
        if (c.taskId && !b.cancelRequested) { applicationErrors.set(c.id, 'The worker record could not be read. No result has been assumed.'); continue; }
        change(s => { const batch = s.batches.find(x => x.id === b.id), chunk = batch.chunks.find(x => x.id === c.id); chunk.status = batch.cancelRequested ? 'cancelled' : 'interrupted'; finishBatch(s, batch); }, 'batch-changed'); continue;
      }
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(t.status)) applyOutcome(b.id, c.id, t);
      else {
        if (!c.taskId) change(s => { const chunk = s.batches.find(x => x.id === b.id).chunks.find(x => x.id === c.id); chunk.taskId = t.id; chunk.status = t.status; }, 'batch-changed');
        watch(b.id, c.id, t.id);
      }
    }
  }
  ctx.cleanup(ctx.workers.register({ id: WORKER_ID, instructions, resultSchema, validateResult }));
  reconcile();

  async function resolveModel(settings) {
    const catalog = await ctx.inference.catalog(); alive();
    const pin = settings.modelOverride ? { model: settings.modelOverride } : catalog.slots?.cheap;
    if (!pin?.model) fail('Configure the cheap model slot or choose an Anki Bridge model override.');
    const entry = catalog.models.find(m => m.provider === pin.model.provider && m.id === pin.model.id);
    if (!entry) fail('The selected model is unavailable. Choose a configured model.');
    const thinkingLevel = settings.thinkingOverride ?? pin.thinkingLevel;
    if (thinkingLevel && !entry.supportedLevels.includes(thinkingLevel)) fail('The selected thinking level is not supported by this model.');
    return { spec: { ...pin.model, ...(thinkingLevel ? { thinkingLevel } : {}) }, entry };
  }
  function register(name, handler) { ctx.handle(name, (input = {}) => { alive(); if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Invalid operation input.'); return handler(input); }); }

  register('get-state', view);
  register('get-catalog', () => ctx.inference.catalog());
  register('save-settings', patch => { change(s => { s.settings = validateSettings(patch, s.settings); }); return view(); });

  register('save-card', ({ id, question, answer }) => {
    requiredText(question, 'Question'); requiredText(answer, 'Answer');
    change(s => { const c = Object.hasOwn(s.cards, id) ? s.cards[id] : fail('Card not found.'); c.question = question; c.answer = answer; c.updatedAt = Date.now(); });
    return view();
  });
  register('delete-card', ({ id }) => {
    if (pushing) fail('Wait for the push to finish before deleting cards.');
    change(s => { if (!Object.hasOwn(s.cards, id)) fail('Card not found.'); delete s.cards[id]; });
    return view();
  });

  register('preflight', async ({ propositionIds }) => {
    if (!Array.isArray(propositionIds) || propositionIds.some(id => typeof id !== 'string')) fail('Select proposition IDs.');
    if (activeBatch(store.get())) fail('A generation batch is already active.');
    const resolved = await resolveModel(store.get().settings);
    const state = store.get(), chunks = pack(graphNow(), propositionIds, state);
    const plans = chunks.map(input => {
      const tokens = estimate(input);
      const maxTokens = Math.min(8192, resolved.entry.maxTokens ?? 8192, (resolved.entry.contextWindow ?? Infinity) - tokens - 256);
      if (maxTokens < 1024) fail('The selected model cannot fit this context and an output allowance. Reduce the chunk budget or choose another model.');
      return { input, prompt: promptFor(input), maxTokens, tokens };
    });
    const id = randomUUID();
    preflights.set(id, { revision: state.revision, settingsHash: fingerprint(state.settings), model: resolved.spec, plans, createdAt: Date.now() });
    for (const [key, value] of preflights) if (Date.now() - value.createdAt > 600000) preflights.delete(key);
    return { id, chunkCount: plans.length, propositionCount: new Set(propositionIds).size, estimatedTokens: plans.reduce((n, p) => n + p.tokens, 0), modelLabel: resolved.entry.name };
  });
  register('start-generation', async ({ preflightId, requestId }) => {
    requiredText(requestId, 'Request ID');
    const previous = store.get().batches.find(b => b.requestId === requestId);
    if (previous) { if (previous.preflightId !== preflightId) fail('This request ID was already used for different work.'); return view(); }
    const plan = preflights.get(preflightId) ?? fail('The generation plan expired. Run preflight again.');
    const resolved = await resolveModel(store.get().settings);
    if (plan.settingsHash !== fingerprint(store.get().settings) || fingerprint(plan.model) !== fingerprint(resolved.spec)) fail('Settings or model changed. Run preflight again.');
    const live = new Set(graphNow().propositions.map(n => n.id));
    if (plan.plans.some(p => p.input.targets.some(id => !live.has(id)))) fail('Selected knowledge changed. Run preflight again.');
    const batchId = randomUUID();
    change(s => {
      if (activeBatch(s)) fail('A generation batch is already active.');
      s.batches.push({ id: batchId, requestId, preflightId, status: 'running', cancelRequested: false, createdAt: Date.now(),
        chunks: plan.plans.map(p => ({ id: randomUUID(), requestId: randomUUID(), targetIds: p.input.targets, status: 'pending', taskId: null, added: 0 })) });
      // Keep only recent batch history.
      if (s.batches.length > 20) s.batches.splice(0, s.batches.length - 20);
    }, 'batch-changed');
    preflights.delete(preflightId);
    queueMicrotask(() => {
      const chunks = store.get().batches.find(b => b.id === batchId).chunks;
      chunks.forEach((chunk, index) => {
        if (disposed || ctx.signal.aborted) return;
        try {
          if (store.get().batches.find(b => b.id === batchId).cancelRequested) return;
          const p = plan.plans[index];
          const task = ctx.workers.start(WORKER_ID, { requestId: chunk.requestId, input: p.input, prompt: p.prompt, model: plan.model, purpose: 'user', maxTurns: 4, options: { maxTokens: p.maxTokens, timeoutMs: 120000, maxRetries: 0 } });
          change(s => { const c = s.batches.find(b => b.id === batchId).chunks.find(c => c.id === chunk.id); c.taskId = task.id; c.status = 'queued'; }, 'batch-changed');
          watch(batchId, chunk.id, task.id);
        } catch (error) {
          const accepted = ctx.workers.list().find(t => t.requestId === chunk.requestId);
          if (accepted) { watch(batchId, chunk.id, accepted.id); applicationErrors.set(chunk.id, error.message); }
          else { try { change(s => { const b = s.batches.find(b => b.id === batchId), c = b.chunks.find(c => c.id === chunk.id); c.status = 'failed'; c.error = error.message; finishBatch(s, b); }, 'batch-changed'); } catch (failure) { applicationErrors.set(chunk.id, failure.message); } }
        }
      });
    });
    return view();
  });
  register('cancel-generation', ({ batchId }) => {
    const b = store.get().batches.find(b => b.id === batchId) ?? fail('Batch not found.');
    change(s => { const current = s.batches.find(x => x.id === b.id); current.cancelRequested = true; current.status = 'cancelling'; for (const c of current.chunks) if (c.status === 'pending') c.status = 'cancelled'; finishBatch(s, current); }, 'batch-changed');
    for (const c of b.chunks) { const t = ctx.workers.list().find(t => t.requestId === c.requestId); if (t && !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(t.status)) ctx.workers.cancel(t.id); }
    reconcile(); return view();
  });
  register('resume-results', () => { reconcile(); return view(); });

  register('test-connection', async () => {
    const anki = client();
    const version = await anki.version();
    const decks = await anki.invoke('deckNames');
    return { ok: true, version, deckCount: Array.isArray(decks) ? decks.length : 0 };
  });

  async function push(cardIds) {
    const s0 = store.get();
    let targets = Object.values(s0.cards);
    if (cardIds !== undefined) {
      if (!Array.isArray(cardIds) || cardIds.some(id => typeof id !== 'string')) fail('Invalid card selection.');
      const wanted = new Set(cardIds); targets = targets.filter(c => wanted.has(c.id));
    }
    targets = targets.filter(c => cardStatus(c) !== 'pushed');
    const summary = { at: Date.now(), attempted: targets.length, created: 0, updated: 0, failed: [] };
    if (!targets.length) return summary;
    const anki = client();
    await anki.version();
    await anki.ensureModel();
    const decksReady = new Set();
    for (const target of targets) {
      if (disposed || ctx.signal.aborted) break;
      const card = store.get().cards[target.id];
      if (!card) continue; // deleted meanwhile
      try {
        const fields = ankiFields(card), hash = fingerprint(fields);
        const found = await anki.findByLhId(card.id);
        let noteId;
        if (found.length) {
          noteId = found[0];
          await anki.updateFields(noteId, fields); summary.updated++;
        } else {
          const deck = deckName(store.get().settings.rootDeck, card.sourceTitle);
          if (!decksReady.has(deck)) { await anki.ensureDeck(deck); decksReady.add(deck); }
          noteId = await anki.addNote(deck, fields, ['learnharness']);
          if (!noteId) fail('Anki did not return a note ID.');
          summary.created++;
        }
        // Record progress per card so an interrupted push resumes correctly.
        change(s => { const c = s.cards[card.id]; if (c) { c.ankiNoteId = noteId; c.pushedHash = hash; c.pushedAt = Date.now(); } });
      } catch (error) {
        summary.failed.push({ cardId: card.id, error: error.message });
        if (/not reachable/.test(error.message)) break;
      }
    }
    return summary;
  }
  register('push', async ({ cardIds }) => {
    if (pushing) fail('A push is already running.');
    pushing = push(cardIds);
    notify();
    try { lastPush = await pushing; }
    catch (error) { lastPush = { at: Date.now(), attempted: 0, created: 0, updated: 0, failed: [], error: error.message }; throw error; }
    finally { pushing = null; notify(); }
    return { summary: lastPush, state: view() };
  });

  // Anki → LearnHarness: propositions whose pushed cards are leeches or lapse often.
  async function struggles() {
    const s = store.get(), threshold = s.settings.struggleLapses;
    const found = await client().struggles(threshold);
    let graph = null;
    try { graph = graphNow(); } catch { /* statements are optional context */ }
    const nodes = new Map((graph?.propositions ?? []).map(n => [n.id, n]));
    const byProposition = new Map();
    for (const hit of found) {
      const card = s.cards[hit.lhId];
      if (!card) continue; // not (or no longer) an Anki Bridge card
      const entry = byProposition.get(card.propositionId) ?? { propositionId: card.propositionId, name: card.propositionName, statement: nodes.get(card.propositionId)?.statement ?? null, inGraph: nodes.has(card.propositionId), lapses: 0, leech: false, cards: [] };
      entry.lapses += hit.lapses; entry.leech ||= hit.leech;
      entry.cards.push({ id: card.id, question: card.question, lapses: hit.lapses, leech: hit.leech });
      byProposition.set(card.propositionId, entry);
    }
    const propositions = [...byProposition.values()].sort((a, b) => Number(b.leech) - Number(a.leech) || b.lapses - a.lapses);
    return { threshold, checkedAt: Date.now(), propositions };
  }
  register('get-struggles', () => struggles());

  if (typeof ctx.registerInstructions !== 'function' || typeof ctx.registerTools !== 'function') fail('This app build does not support plugin agent tools required by Anki Bridge.');
  ctx.cleanup(ctx.registerInstructions({ agents: ['practice'], text: PRACTICE_INSTRUCTIONS }));
  ctx.cleanup(ctx.registerTools({
    agents: ['practice'],
    create: () => [{
      name: 'anki_struggles',
      label: 'Anki struggles',
      description: 'Read-only: list LearnHarness propositions whose Anki flashcards the learner keeps forgetting (leech-tagged or frequently lapsed). Does not change Anki or learning records.',
      parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false },
      execute: async (_toolCallId, input = {}, signal) => {
        if (signal?.aborted || ctx.signal.aborted) throw new Error('Anki struggles lookup cancelled');
        const limit = Number.isSafeInteger(input.limit) ? Math.min(20, Math.max(1, input.limit)) : 10;
        let result;
        try { result = await struggles(); }
        catch (error) {
          return { content: [{ type: 'text', text: `Anki struggle data unavailable: ${error.message} Continue practice without it.` }], details: { available: false } };
        }
        return { content: [{ type: 'text', text: formatStruggles(result, limit) }], details: { available: true, count: result.propositions.length } };
      },
    }],
  }));

  ctx.cleanup(() => { disposed = true; for (const stop of observers.values()) stop(); observers.clear(); preflights.clear(); });
}

module.exports = { activate, pack, validateResult, validateSettings, estimate, ankiFields, cardStatus, resultSchema, instructions, WORKER_ID, PRACTICE_INSTRUCTIONS, formatStruggles };

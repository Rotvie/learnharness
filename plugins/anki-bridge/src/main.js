const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const message = error => error instanceof Error ? error.message : String(error);
const uuid = () => crypto.randomUUID();
const ankiIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="12" height="15" rx="2"/><path d="M9 3h10a2 2 0 0 1 2 2v11"/><path d="M15 12h6M18 9l3 3-3 3"/></svg>';
const activeBatch = batch => batch && ['running', 'pending', 'queued', 'cancelling'].includes(batch.status);
const STATUS_LABEL = { new: 'New', changed: 'Changed', pushed: 'In Anki', conflict: 'Conflict' };
const toPush = card => card.status === 'new' || card.status === 'changed';
function lifetime(...parents) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const parent of parents) { if (parent.aborted) abort(); else parent.addEventListener('abort', abort, { once: true }); }
  controller.signal.addEventListener('abort', () => { for (const parent of parents) parent.removeEventListener('abort', abort); }, { once: true });
  return controller;
}

export function activate(ctx) {
  for (const capability of ['mountMarkdown', 'mountKnowledgePicker', 'mountTree', 'openDialog', 'mountButton', 'mountSettingsRows']) {
    if (typeof ctx.ui?.[capability] !== 'function') throw new Error(`Anki Bridge requires a newer LearnHarness host with ctx.ui.${capability}. Please update LearnHarness.`);
  }
  let snapshot = null, refreshing = null, refreshAgain = false;
  const observers = new Set(), registrations = [];
  const publish = value => {
    if (!value || ctx.signal.aborted || (snapshot && value.revision < snapshot.revision)) return;
    snapshot = value; for (const observer of observers) observer(value);
  };
  const report = error => { for (const observer of observers) observer(null, message(error)); };
  const refresh = () => {
    if (!observers.size || ctx.signal.aborted) return Promise.resolve();
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        try { const state = await ctx.call('get-state'); if (observers.size) publish(state); }
        catch (error) { if (observers.size) report(error); }
      } while (refreshAgain && observers.size && !ctx.signal.aborted);
    })().finally(() => { refreshing = null; });
    return refreshing;
  };
  const observe = (fn, signal) => {
    observers.add(fn); signal.addEventListener('abort', () => observers.delete(fn), { once: true });
    if (snapshot) fn(snapshot); void refresh();
  };
  function widget(handle, signal) {
    if (signal.aborted) handle.dispose(); else signal.addEventListener('abort', () => handle.dispose(), { once: true });
    return handle;
  }
  function button(parent, label, action, signal, options = {}) {
    const slot = el('span', 'ab-button'); parent.append(slot);
    let pending = false, disabled = !!options.disabled;
    const handle = widget(ctx.ui.mountButton(slot, { label, size: 'sm', variant: 'outline', ...options, onClick: async () => {
      if (pending || signal.aborted || disabled) return;
      pending = true; handle.update({ disabled: true });
      try { await action(); } finally { pending = false; if (!signal.aborted) handle.update({ disabled }); }
    } }, { signal }), signal);
    return { update(props) { if (Object.hasOwn(props, 'disabled')) disabled = props.disabled; handle.update({ ...props, disabled: pending || disabled }); }, dispose: () => handle.dispose() };
  }
  function markdown(parent, text, signal) {
    const slot = el('div', 'ab-markdown'); parent.append(slot);
    return widget(ctx.ui.mountMarkdown(slot, { text: text || '' }, { signal }), signal);
  }
  async function mutate(operation, input, signal) {
    const value = await ctx.call(operation, input);
    if (signal.aborted) return false;
    publish(value); return true;
  }
  function field(parent, label, value, type = 'text') {
    const wrapper = el('label', 'ab-field'), input = el(type === 'textarea' ? 'textarea' : 'input', 'ab-input');
    if (type !== 'textarea') input.type = type;
    input.value = String(value ?? ''); wrapper.append(el('span', 'ab-label', label), input); parent.append(wrapper); return input;
  }
  function dialog(title, parentSignal, build, closeLabel = 'Cancel') {
    let handle;
    handle = ctx.ui.openDialog({ title, content: (container, hostSignal) => {
      const scope = lifetime(parentSignal, hostSignal, ctx.signal), root = el('div', 'ab-root ab-dialog');
      const error = el('p', 'ab-error'); error.setAttribute('role', 'alert');
      root.append(el('h2', 'ab-dialog-heading', title)); container.append(root);
      const actions = el('div', 'ab-actions');
      const run = action => async () => { try { await action(); } catch (cause) { if (!scope.signal.aborted) error.textContent = message(cause); } };
      build({ root, actions, signal: scope.signal, run, close: () => handle?.dispose() });
      root.append(error, actions); button(actions, closeLabel, () => handle?.dispose(), scope.signal, { variant: 'ghost' });
      return () => { scope.abort(); root.remove(); };
    } }, { signal: parentSignal });
    return widget(handle, parentSignal);
  }
  async function confirmGeneration(propositionIds, signal, showError) {
    try {
      const preflight = await ctx.call('preflight', { propositionIds: [...propositionIds] });
      if (signal.aborted) return;
      const requestId = uuid();
      dialog('Generate Anki cards', signal, ({ root, actions, signal: ds, run, close }) => {
        root.append(el('p', 'ab-muted', `${preflight.propositionCount} propositions (approximately ${preflight.estimatedTokens.toLocaleString()} input tokens) · ${preflight.modelLabel}`));
        button(actions, 'Start', run(async () => { if (await mutate('start-generation', { preflightId: preflight.id, requestId }, ds)) close(); }), ds, { variant: 'default' });
      });
    } catch (error) { if (!signal.aborted) showError(message(error)); }
  }
  function editCard(card, signal) {
    dialog('Edit card', signal, ({ root, actions, signal: ds, run, close }) => {
      root.append(el('p', 'ab-muted', `${card.propositionName} · ${card.sourceTitle} · ${card.tag}`));
      if (card.conflict) {
        const box = el('section', 'ab-conflict');
        box.append(el('p', '', 'This note was edited in Anki after its last push, so it was not overwritten. Anki currently has:'));
        for (const [label, html] of [['Question', card.conflict.question], ['Answer', card.conflict.answer]]) box.append(el('span', 'ab-label', label), el('pre', 'ab-anki-html', html));
        const choices = el('div', 'ab-actions');
        const resolve = keep => run(async () => { const result = await ctx.call('resolve-conflict', { id: card.id, keep }); if (ds.aborted) return; publish(result.state); close(); });
        button(choices, 'Overwrite Anki', resolve('local'), ds, { variant: 'destructive', title: 'Replace the Anki note with this card (review history is kept).' });
        button(choices, 'Keep Anki version', resolve('anki'), ds, { title: 'Leave Anki as it is; this card counts as in sync until you edit it here again.' });
        box.append(choices); root.append(box);
      }
      const question = field(root, 'Question (Markdown)', card.question, 'textarea');
      const answer = field(root, 'Answer (Markdown)', card.answer, 'textarea');
      const preview = el('div', 'ab-preview'); root.append(preview);
      let previewScope = lifetime(ds);
      const renderPreview = () => {
        previewScope.abort(); previewScope = lifetime(ds); preview.replaceChildren();
        markdown(preview, question.value, previewScope.signal);
        preview.append(el('hr'));
        markdown(preview, answer.value, previewScope.signal);
      };
      renderPreview();
      question.addEventListener('input', renderPreview, { signal: ds }); answer.addEventListener('input', renderPreview, { signal: ds });
      if (card.status !== 'new') root.append(el('p', 'ab-muted', 'Saving marks the card as changed; the next push updates the Anki note in place and keeps its review history.'));
      button(actions, 'Save', run(async () => { if (await mutate('save-card', { id: card.id, question: question.value, answer: answer.value }, ds)) close(); }), ds, { variant: 'default' });
      button(actions, 'Delete', run(async () => { if (await mutate('delete-card', { id: card.id }, ds)) close(); }), ds, { variant: 'destructive', title: 'Delete from Anki Bridge only; notes already in Anki stay there.' });
    });
  }

  function mountLibrary(container, hostSignal) {
    const scope = lifetime(hostSignal, ctx.signal), signal = scope.signal;
    const root = el('div', 'ab-root ab-library'), toolbar = el('div', 'ab-toolbar'), error = el('p', 'ab-error');
    error.setAttribute('role', 'alert');
    const showError = text => { if (!signal.aborted) error.textContent = text; };
    const guarded = action => async () => { try { error.textContent = ''; await action(); } catch (cause) { showError(message(cause)); } };

    // Generation: knowledge picker → preflight → confirm.
    const pickerSlot = el('div', 'ab-picker');
    let generationIds = [], generationButton;
    const picker = widget(ctx.ui.mountKnowledgePicker(pickerSlot, { value: generationIds, onChange: ids => {
      generationIds = [...ids]; picker.update({ value: generationIds }); updateButtons();
    } }, { signal }), signal);
    toolbar.append(pickerSlot);
    generationButton = button(toolbar, 'Generate', () => confirmGeneration(generationIds, signal, showError), signal, { disabled: true, variant: 'default' });

    // Anki panel: connection + push.
    const ankiPanel = el('section', 'ab-anki'), ankiStatus = el('p', 'ab-muted'), pushResult = el('div', 'ab-push-result');
    ankiStatus.setAttribute('role', 'status');
    const ankiActions = el('div', 'ab-actions');
    const deckLine = el('p', 'ab-muted');
    ankiPanel.append(ankiActions, deckLine, ankiStatus, pushResult);
    button(ankiActions, 'Test connection', guarded(async () => {
      ankiStatus.textContent = 'Connecting…';
      try {
        const result = await ctx.call('test-connection');
        if (!signal.aborted) ankiStatus.textContent = `Connected · AnkiConnect v${result.version} · ${result.deckCount} decks`;
      } catch (cause) { if (!signal.aborted) ankiStatus.textContent = ''; throw cause; }
    }), signal);
    const pushButton = button(ankiActions, 'Push to Anki', guarded(async () => {
      const result = await ctx.call('push', {});
      if (signal.aborted) return;
      publish(result.state);
    }), signal, { variant: 'default', disabled: true });

    const batchArea = el('div'), treeSlot = el('div', 'ab-tree'), empty = el('p', 'ab-muted');

    // Struggling in Anki: leech-tagged or frequently lapsed pushed cards, per proposition.
    const strugglePanel = el('section', 'ab-struggles'), struggleHeader = el('div', 'ab-actions'), struggleBody = el('div');
    struggleHeader.append(el('h3', 'ab-section-heading', 'Struggling in Anki'));
    strugglePanel.append(struggleHeader, struggleBody);
    let loadingStruggles = false;
    async function loadStruggles() {
      if (loadingStruggles || signal.aborted) return;
      loadingStruggles = true; struggleBody.replaceChildren(el('p', 'ab-muted', 'Checking Anki…'));
      try {
        const result = await ctx.call('get-struggles');
        if (signal.aborted) return;
        struggleBody.replaceChildren();
        if (!result.propositions.length) { struggleBody.append(el('p', 'ab-muted', `Nothing struggling (leech tag or ${result.threshold}+ lapses).`)); return; }
        struggleBody.append(el('p', 'ab-muted', `Leech tag or ${result.threshold}+ lapses. Practice sessions can see this list.`));
        const list = el('ul', 'ab-struggle-list');
        for (const p of result.propositions) {
          const item = el('li'), head = el('div', 'ab-struggle-head');
          head.append(el('strong', '', p.name), el('span', 'ab-muted', ` · ${p.lapses} lapses${p.leech ? ' · leech' : ''}${p.inGraph ? '' : ' · not in graph'}`));
          const cards = el('ul', 'ab-struggle-cards');
          for (const c of p.cards) cards.append(el('li', 'ab-muted', `${c.question.replace(/\s+/g, ' ').trim().slice(0, 120)} (${c.lapses}${c.leech ? ', leech' : ''})`));
          item.append(head, cards); list.append(item);
        }
        struggleBody.append(list);
      } catch (cause) { if (!signal.aborted) struggleBody.replaceChildren(el('p', 'ab-muted', message(cause))); }
      finally { loadingStruggles = false; }
    }
    button(struggleHeader, 'Refresh', loadStruggles, signal, { variant: 'ghost' });

    root.append(toolbar, error, ankiPanel, strugglePanel, batchArea, treeSlot, empty); container.append(root);
    void loadStruggles();

    function updateButtons() {
      const busy = !!activeBatch(snapshot?.batch);
      generationButton.update({ disabled: !generationIds.length || busy });
      const pending = (snapshot?.cards ?? []).filter(toPush).length;
      pushButton.update({ label: snapshot?.pushing ? 'Pushing…' : pending ? `Push ${pending} to Anki` : 'Push to Anki', disabled: !pending || !!snapshot?.pushing });
    }
    function renderPush(lastPush) {
      pushResult.replaceChildren();
      const conflicts = (snapshot?.cards ?? []).filter(c => c.status === 'conflict').length;
      if (conflicts) pushResult.append(el('p', 'ab-error', `${conflicts} ${conflicts === 1 ? 'card was' : 'cards were'} edited in Anki and not overwritten. Open a card marked Conflict to choose a version.`));
      if (!lastPush) return;
      if (lastPush.error) { pushResult.append(el('p', 'ab-error', `Push failed: ${lastPush.error}`)); return; }
      pushResult.append(el('p', 'ab-muted', `Last push: ${lastPush.created} created, ${lastPush.updated} updated, ${lastPush.conflicts ?? 0} conflicts, ${lastPush.failed.length} failed.`));
      if (lastPush.notice) pushResult.append(el('p', 'ab-muted', lastPush.notice));
      const names = new Map((snapshot?.cards ?? []).map(c => [c.id, c.question]));
      for (const f of lastPush.failed.slice(0, 10)) pushResult.append(el('p', 'ab-error', `${(names.get(f.cardId) || f.cardId).slice(0, 80)}: ${f.error}`));
    }
    let batchScope = lifetime(signal);
    function renderBatch(batch) {
      batchScope.abort(); batchScope = lifetime(signal); batchArea.replaceChildren();
      if (!batch || (batch.status === 'completed' && !batch.error && !batch.chunks.some(chunk => chunk.error))) return;
      const bs = batchScope.signal, panel = el('section', 'ab-batch'); batchArea.append(panel);
      panel.append(el('p', '', `Generation: ${batch.status} · ${batch.completed}/${batch.total} chunks · ${batch.added} cards added`));
      for (const chunk of batch.chunks.filter(chunk => chunk.error)) panel.append(el('p', 'ab-error', chunk.error));
      if (batch.error) panel.append(el('p', 'ab-error', batch.error));
      const controls = el('div', 'ab-actions'); panel.append(controls);
      if (activeBatch(batch)) button(controls, 'Cancel generation', guarded(() => mutate('cancel-generation', { batchId: batch.id }, signal)), bs);
      if (!activeBatch(batch) && batch.failedTargetIds?.length) button(controls, 'Retry failed…', () => confirmGeneration(batch.failedTargetIds, signal, showError), bs);
      if (batch.error) button(controls, 'Retry saving', guarded(() => mutate('resume-results', {}, signal)), bs);
    }

    // Tree: source (one learnharness::<source> tag each) → card.
    const expanded = new Set(), factories = new Map(), records = new Map();
    function cardContent(key) {
      if (factories.has(key)) return factories.get(key);
      const factory = (slot, mountSignal) => {
        const record = records.get(key);
        const label = el('button', 'ab-card-label'); label.type = 'button';
        label.textContent = record.card.question.replace(/\s+/g, ' ').trim();
        label.title = 'Edit card';
        label.addEventListener('click', event => { event.stopPropagation(); editCard(records.get(key).card, signal); }, { signal: mountSignal });
        slot.append(label);
        record.refresh = () => { label.textContent = records.get(key).card.question.replace(/\s+/g, ' ').trim(); };
        return () => { label.remove(); };
      };
      factories.set(key, factory); return factory;
    }
    const tree = widget(ctx.ui.mountTree(treeSlot, { label: 'Anki Bridge cards', header: 'Card', rows: [], columns: [{ key: 'status', header: 'Status', width: '6rem', align: 'right' }] }, { signal }), signal);
    function renderTree(state) {
      const groups = new Map();
      for (const card of state.cards) { if (!groups.has(card.tag)) groups.set(card.tag, []); groups.get(card.tag).push(card); }
      const rows = [...groups].map(([tag, cards]) => {
        const key = `tag:${tag}`;
        const pending = cards.filter(toPush).length, conflicts = cards.filter(c => c.status === 'conflict').length;
        return {
          key, content: cards[0].sourceTitle || tag,
          cells: { status: conflicts ? `${conflicts} conflict${conflicts === 1 ? '' : 's'}` : pending ? `${pending} to push` : 'In Anki' },
          children: cards.map(card => {
            const cardKey = `card:${card.id}`;
            if (records.has(cardKey)) { records.get(cardKey).card = card; records.get(cardKey).refresh?.(); } else records.set(cardKey, { card });
            return { key: cardKey, content: cardContent(cardKey), cells: { status: STATUS_LABEL[card.status] } };
          }),
          disclosure: { label: `Toggle ${tag}`, expanded: expanded.has(key), onChange(value) { if (value) expanded.add(key); else expanded.delete(key); renderTree(snapshot); } },
        };
      });
      tree.update({ rows });
      empty.textContent = rows.length ? '' : 'No cards yet. Pick knowledge above and Generate, then push to Anki.';
      empty.hidden = !!rows.length;
    }

    observe((state, loadError) => {
      if (signal.aborted) return; if (loadError) { showError(loadError); return; }
      deckLine.textContent = `New notes go to deck "${state.deck}", tagged learnharness::<source>.`;
      updateButtons(); renderBatch(state.batch); renderPush(state.lastPush); renderTree(state);
    }, signal);
    return () => { scope.abort(); root.remove(); };
  }

  function mountSettings(container, hostSignal) {
    const scope = lifetime(hostSignal, ctx.signal), signal = scope.signal;
    const root = el('div', 'ab-root ab-settings'), error = el('p', 'ab-error'), fields = el('div'), modelArea = el('div', 'ab-model-settings');
    error.setAttribute('role', 'alert'); root.append(fields, modelArea, error); container.append(root);
    let initialized = false, rows, followRows, modelPicker, thinkingPicker, modelPickers, catalog = null;
    let overrideDraft = false, modelBusy = false, decks = null;
    const followingCheap = settings => !overrideDraft && !settings.modelOverride && settings.thinkingOverride == null;
    const showError = cause => { if (!signal.aborted) error.textContent = message(cause); };
    const save = async patch => {
      try { const state = await ctx.call('save-settings', patch); if (signal.aborted) return; error.textContent = ''; publish(state); rows?.update({ rows: settingsRows(snapshot.settings) }); updateModels(snapshot.settings); }
      catch (cause) { showError(cause); throw cause; }
    };
    const settingsRows = settings => {
      const row = (key, label, value, type, parse = value => value, extras = {}) => ({ key, label, value, type, ...extras, onChange: async value => { try { await save({ [key]: parse(value) }); } catch (cause) { showError(cause); throw cause; } } });
      return [
        row('ankiUrl', 'AnkiConnect URL', settings.ankiUrl, 'text'),
        row('apiKey', 'AnkiConnect API key (optional, stored locally)', settings.apiKey, 'text'),
        decks
          ? row('deck', 'Anki deck for new notes', settings.deck, 'dropdown', value => value, { options: [...new Set([settings.deck, ...decks])].map(name => ({ value: name, label: name })) })
          : row('deck', 'Anki deck for new notes', settings.deck, 'text', value => value, { description: 'Open Anki to pick from your decks. A deck that does not exist is created.' }),
        row('chunkBudget', 'Generation chunk budget (estimated tokens)', settings.chunkBudget, 'number', Number, { min: 1, step: 1 }),
        row('struggleLapses', 'Struggle lapse threshold (leech tag always counts)', settings.struggleLapses, 'number', Number, { min: 1, max: 100, step: 1 }),
      ];
    };
    const changeModels = async patch => {
      if (modelBusy || signal.aborted) return;
      modelBusy = true; updateModels(snapshot.settings);
      try { await save(patch); if (!signal.aborted) overrideDraft = false; }
      finally { modelBusy = false; if (!signal.aborted) updateModels(snapshot.settings); }
    };
    const followCheapRow = settings => ({ key: 'followCheapSlot', label: 'Model', description: 'Follow cheap slot', type: 'toggle', value: followingCheap(settings), disabled: modelBusy,
      onChange: async follow => {
        if (modelBusy || signal.aborted) return;
        if (follow) await changeModels({ modelOverride: null, thinkingOverride: null });
        else if (catalog?.slots?.cheap?.model) await changeModels({ modelOverride: catalog.slots.cheap.model, thinkingOverride: catalog.slots.cheap.thinkingLevel ?? null });
        else { overrideDraft = true; updateModels(snapshot.settings); }
      },
    });
    const updateModels = settings => {
      const following = followingCheap(settings), model = settings.modelOverride || catalog?.slots?.cheap?.model || undefined;
      followRows?.update({ rows: [followCheapRow(settings)] });
      if (modelPickers) modelPickers.hidden = following;
      modelPicker?.update({ value: model, disabled: following || modelBusy });
      thinkingPicker?.update({ model, value: settings.thinkingOverride ?? (settings.modelOverride ? undefined : catalog?.slots?.cheap?.thinkingLevel), disabled: following || modelBusy || !model });
    };
    observe((state, loadError) => {
      if (signal.aborted) return; if (loadError) { showError(loadError); return; }
      if (!initialized) {
        initialized = true; rows = widget(ctx.ui.mountSettingsRows(fields, { rows: settingsRows(state.settings) }, { signal }), signal);
        const followSlot = el('div');
        modelPickers = el('div', 'ab-model-overrides');
        const modelSlot = el('div'), thinkingSlot = el('div');
        modelPickers.append(modelSlot, thinkingSlot); modelArea.append(followSlot, modelPickers);
        followRows = widget(ctx.ui.mountSettingsRows(followSlot, { rows: [followCheapRow(state.settings)] }, { signal }), signal);
        if (typeof ctx.ui.mountModelPicker === 'function') modelPicker = widget(ctx.ui.mountModelPicker(modelSlot, { value: state.settings.modelOverride || undefined, onChange: async value => { try { await changeModels({ modelOverride: value, thinkingOverride: null }); } catch { /* error shown */ } } }, { signal }), signal);
        if (typeof ctx.ui.mountThinkingPicker === 'function') thinkingPicker = widget(ctx.ui.mountThinkingPicker(thinkingSlot, { model: state.settings.modelOverride || undefined, value: state.settings.thinkingOverride ?? undefined, onChange: async value => { try { await changeModels({ thinkingOverride: value }); } catch { /* error shown */ } } }, { signal }), signal);
        updateModels(state.settings);
        void ctx.call('list-decks').then(value => { if (!signal.aborted) { decks = value; rows.update({ rows: settingsRows(snapshot.settings) }); } }).catch(() => { /* Anki closed: free-text deck */ });
        void ctx.call('get-catalog').then(value => { if (!signal.aborted) { catalog = value; updateModels(snapshot.settings); } }).catch(showError);
      } else { rows.update({ rows: settingsRows(state.settings) }); updateModels(state.settings); }
    }, signal);
    return () => { scope.abort(); root.remove(); };
  }

  registrations.push(ctx.registerView({ id: 'library', name: 'Anki Bridge', mount: mountLibrary }));
  registrations.push(ctx.registerAction({ id: 'open', name: 'Anki Bridge', icon: ankiIcon, run: () => ctx.app.openView('library') }));
  registrations.push(ctx.placeAction({ id: 'open-sidebar', actionId: 'open', location: 'sidebar' }));
  registrations.push(ctx.registerSettings(mountSettings));
  registrations.push(ctx.onNotification(event => { if ((!event.pluginId || event.pluginId === ctx.manifest.id) && ['changed', 'batch-changed'].includes(event.topic)) void refresh(); }));
  registrations.push(ctx.onResync(() => { void refresh(); }));
  registrations.push(ctx.onAppEvent(event => { if (['sources-changed', 'chats-changed'].includes(event.type)) void refresh(); }));
  const dispose = () => { for (const unregister of registrations.splice(0).reverse()) unregister(); observers.clear(); };
  ctx.cleanup(dispose); return dispose;
}

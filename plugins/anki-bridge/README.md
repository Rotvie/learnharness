# Anki Bridge

A Community LearnHarness plugin: generate fact-recall cards from selected knowledge-graph
propositions, review and edit them, then push them **one-way** into Anki through
[AnkiConnect](https://ankiweb.net/shared/info/2055492159). Anki owns scheduling and review.

Independent of the Core Flashcards plugin: it has its own ID, data and cards.

## Requirements

- Anki desktop running, with the AnkiConnect add-on (code `2055492159`), protocol version 6+.
- A configured cheap model slot in LearnHarness, or a model override in this plugin's settings.
  Generation calls your model and may incur cost.

## Build and install

```sh
cd plugins/anki-bridge
npm ci
npm run build
npm test
node ../../scripts/install-plugin-local.mjs "<plugins-directory>"
```

Copy `<plugins-directory>` from **Settings → Community plugins**, then Refresh and enable
**Anki Bridge**. Restart LearnHarness after rebuilding already-loaded code.

## Use

1. Open **Anki Bridge** from the sidebar.
2. Pick propositions with the knowledge picker, press **Generate**, confirm the token estimate.
3. Cards appear grouped by source. Click a card to edit it or delete it.
4. **Test connection**, then **Push N to Anki**.

Pick the target deck in this plugin's settings: with Anki open it is a list of your decks
(for example your existing `Obsidian` deck); with Anki closed it is a text field.

## How cards land in Anki

- **Note type** `LearnHarness`, created on first push. Fields: `Question`, `Answer`,
  `Proposition`, `Source`, `LHId`. Single card template "Recall". No fixed colors, so Anki's
  light/dark theme applies; the proposition/source context shows only when present.
  If a note type with that name already exists without these fields, push is refused.
  A note type still exactly like the earlier template is upgraded on push; one you customized in
  Anki is left unchanged and the push result says so.
- **Deck**: the single deck chosen in settings (default `LearnHarness`; may nest, e.g.
  `Study::LH`). No subdecks are created. A deck that does not exist yet is created.
- **Tags** `learnharness` and `learnharness::<source>` (one per LearnHarness source: teaching
  session or imported notes file). Spaces become `_`; accents and Japanese are kept. Browse
  them in Anki's sidebar, or search `tag:learnharness::Álgebra_lineal`.
- **Formatting**: Markdown → HTML; `$…$` → `\(…\)` and `$$…$$` → `\[…\]` for Anki's built-in
  MathJax. Generation forbids Mermaid, images and raw HTML.

## Card formulation

Generation follows the Core Flashcards card-writing guidance plus the applicable rules from
SuperMemo's "Twenty rules of formulating knowledge": minimum information, no sets or
enumerations, optimized wording, topic-prefix context cues, interference avoidance, references
to other memories, examples, redundancy, date stamping and prioritizing.

Generated cards are rejected (the model must fix and resubmit) when:

- the answer is longer than 300 characters;
- the question lacks a `Topic: ` prefix (2–40 characters before the colon);
- the answer is a list (2+ list items, 3+ comma-joined items with and/or, or 4+ comma items);
- the whole answer already appears in the question;
- the answer is only yes/no/true/false.

Math (`$…$`, `$$…$$`) and code are ignored by these checks.

## Struggling in Anki

Pushed cards tagged `leech` in Anki, or with lapses ≥ the **Struggle lapse threshold**
(default 3), are grouped per proposition and listed in the **Struggling in Anki** panel.
The **Practice** agent gets a read-only `anki_struggles` tool and a short instruction to
prefer problems exercising those propositions. If Anki is closed, the tool says so and
practice continues. Nothing is written to Anki or to learning records.

## Re-push behavior

Each card's identity is its `LHId` (with the Anki note ID recorded at push as a fallback, so a
damaged `LHId` is found and repaired). Status is **New**, **Changed** (edited since its last
push), **In Anki** or **Conflict**. Pushing sends New and Changed cards only:

- note exists and is unchanged in Anki since the last push → fields updated in place, source
  tag added; Anki review history is kept;
- note exists but was **edited in Anki** → left untouched; the card becomes **Conflict**. Open
  it to see Anki's version and choose **Overwrite Anki** or **Keep Anki version** (the card then
  counts as in sync until you edit it here again);
- note missing (never pushed, or deleted in Anki) → created again.

Moving a note to another deck in Anki is kept: updates never move notes, and notes created by
the earlier version stay in their per-source subdecks (they gain the source tag when next pushed). Tags are
only added, never removed. Changing the deck setting only affects newly created notes.
Deleting a card in Anki Bridge does **not** delete its Anki note.

## Settings

AnkiConnect URL (default `http://127.0.0.1:8765`), optional AnkiConnect API key (stored in
plain text in plugin data), Anki deck for new notes, generation chunk budget, struggle lapse
threshold, model/thinking override.

## Data

`<plugins-directory>/anki-bridge/data/anki-bridge.json`: cards, push state, settings, recent
generation batches.

## License

AGPL-3.0-only, matching LearnHarness. Card-writing prompt adapted from the Core Flashcards
plugin. Bundles [marked](https://github.com/markedjs/marked) (MIT; see `MARKED-LICENSE`).

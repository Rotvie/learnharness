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
3. Cards appear grouped by their Anki deck. Click a card to edit it or delete it.
4. **Test connection**, then **Push N to Anki**.

## How cards land in Anki

- **Note type** `LearnHarness`, created on first push. Fields: `Question`, `Answer`,
  `Proposition`, `Source`, `LHId`. Single card template "Recall".
  If a note type with that name already exists without these fields, push is refused.
- **Deck** `<root>::<source title>`, one subdeck per LearnHarness source (teaching session or
  imported notes file). Root defaults to `LearnHarness` and may itself nest (`Study::LH`).
- **Tag** `learnharness`.
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

Each card's identity is its `LHId`. Status is **New**, **Changed** (edited since its last push)
or **In Anki**. Pushing sends New and Changed cards only:

- note with that `LHId` exists → fields updated in place; Anki review history is kept;
- note missing (never pushed, or deleted in Anki) → created again.

Moving a note to another deck in Anki is kept: updates do not move notes. Changing the root
deck setting only affects newly created notes. Deleting a card in Anki Bridge does **not**
delete its Anki note. Edits made inside Anki are overwritten when that card is next pushed
as Changed.

## Settings

AnkiConnect URL (default `http://127.0.0.1:8765`), optional AnkiConnect API key (stored in
plain text in plugin data), root deck, generation chunk budget, model/thinking override.

## Data

`<plugins-directory>/anki-bridge/data/anki-bridge.json`: cards, push state, settings, recent
generation batches.

## License

AGPL-3.0-only, matching LearnHarness. Card-writing prompt adapted from the Core Flashcards
plugin. Bundles [marked](https://github.com/markedjs/marked) (MIT; see `MARKED-LICENSE`).

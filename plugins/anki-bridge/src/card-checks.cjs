'use strict';
// Hard formulation checks (SuperMemo rules 9/10/16 and effortful retrieval).
// Math ($...$, $$...$$) and code (`...`, fences) are ignored by every check.

const MAX_PREFIX = 40;

function stripMathAndCode(text) {
  return text
    .replace(/(^|\n) {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n {0,3}\2[ \t]*(?=\n|$)|$)/g, '$1')
    .replace(/`+[^`]*`+/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/(^|[^\\])\$[^$\n]+?\$/g, '$1 ');
}

// Lowercase, drop Markdown emphasis and punctuation, collapse whitespace.
function normalize(text) {
  return stripMathAndCode(text).toLowerCase()
    .replace(/[*_~#>]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}

function topicPrefixError(question) {
  const m = /^([^:\n]+):\s+\S/.exec(question.trim());
  const topic = m?.[1].trim() ?? '';
  if (!m || topic.length < 2 || topic.length > MAX_PREFIX) return `Question must start with a short topic prefix such as "Group theory: " (2–${MAX_PREFIX} characters before the colon).`;
  return null;
}

function listAnswerError(answer) {
  const text = stripMathAndCode(answer);
  const listItems = text.split('\n').filter(line => /^\s*([-*+]|\d+[.)])\s+\S/.test(line)).length;
  if (listItems >= 2) return 'Answer is a list. Ask for one member per card instead (no sets or enumerations).';
  for (const line of text.split('\n')) {
    const commas = (line.match(/,/g) || []).length;
    if (!commas) continue;
    const tail = line.slice(line.lastIndexOf(',') + 1);
    const joined = /\b(?:and|or)\b/i.test(tail);
    const oxford = /^\s*(?:and|or)\b/i.test(tail);
    // "a, b and c" = 3 items; "a, b, and c" = 3 items; "a, b, c, d" = 4 items.
    const items = commas + 1 + (joined && !oxford ? 1 : 0);
    if ((joined && items >= 3) || items >= 4) {
      return 'Answer enumerates several items. Ask for one member per card instead (no sets or enumerations).';
    }
  }
  return null;
}

function leakError(question, answer) {
  const a = normalize(answer), q = normalize(question);
  if (a.length >= 4 && ` ${q} `.includes(` ${a} `)) return 'The answer already appears in the question. Rephrase so the learner must retrieve it.';
  return null;
}

function yesNoError(answer) {
  if (/^(yes|no|true|false)$/.test(normalize(answer))) return 'Answer is only yes/no/true/false. Ask for the fact itself instead.';
  return null;
}

// Returns the first failing rule's message, or null when the card passes.
function checkCard({ question, answer }) {
  return topicPrefixError(question) ?? yesNoError(answer) ?? listAnswerError(answer) ?? leakError(question, answer);
}

module.exports = { checkCard, normalize, stripMathAndCode, topicPrefixError, listAnswerError, leakError, yesNoError };

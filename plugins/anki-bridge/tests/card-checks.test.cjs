'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkCard } = require('../src/card-checks.cjs');

const ok = (question, answer) => assert.equal(checkCard({ question, answer }), null, `${question} → ${answer}`);
const bad = (question, answer, pattern) => assert.match(checkCard({ question, answer }) ?? '', pattern, `${question} → ${answer}`);

test('topic prefix is required, 2-40 characters', () => {
  bad('What is closure?', 'x', /topic prefix/);
  bad('G: what is closure?', 'x', /topic prefix/);
  bad(`${'x'.repeat(41)}: what?`, 'y', /topic prefix/);
  bad('Group theory:what?', 'y', /topic prefix/);
  ok('Group theory: axiom guaranteeing $a*b \\in G$?', 'closure');
  ok(`${'x'.repeat(40)}: what?`, 'y');
});

test('yes/no answers are rejected; answers merely starting with yes are not', () => {
  bad('Topic: is TCP reliable?', 'Yes.', /yes\/no/);
  bad('Topic: is UDP reliable?', '**False**', /yes\/no/);
  ok('Topic: what does TCP guarantee?', 'Yes-acknowledged in-order delivery');
});

test('list-shaped answers are rejected', () => {
  bad('Group theory: group axioms?', '- closure\n- associativity', /list/);
  bad('Group theory: group axioms?', '1. closure\n2. identity', /list/);
  bad('Group theory: group axioms?', 'closure, associativity, identity and inverses', /enumerates/);
  bad('Group theory: three axioms?', 'closure, associativity, and identity', /enumerates/);
  bad('Group theory: three axioms?', 'closure, identity or inverses', /enumerates/);
  bad('Colors: primaries?', 'red, green, blue, yellow', /enumerates/);
  ok('Group theory: two properties?', 'closure and associativity');
  ok('Physics: unit of force?', 'newton, i.e. kg·m/s²');
  ok('Algebra: tuple notation?', '$(a, b, c, d)$');
  ok('Code: call?', '`f(a, b, c, d)`');
  ok('Algebra: one list item?', '- closure');
});

test('answers appearing in the question are rejected', () => {
  bad('Group theory: which axiom is closure about?', 'Closure', /already appears/);
  bad('Networking: the transmission control protocol guarantees what?', 'transmission control protocol', /already appears/);
  ok('Group theory: axiom guaranteeing $a*b \\in G$?', 'closure');
  ok('Group theory: the identity element?', 'id'); // shorter than 4 characters
  ok('Math: what is $x$ here?', '$x$'); // math ignored
});

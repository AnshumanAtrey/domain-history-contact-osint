import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateTokens } from '../src/extractors/entities.js';

const tok = (word, entity, score = 0.99) => ({ word, entity, score });

test('a ## subtoken glues to its word even when the model tags it O', () => {
  // Measured failure: "Anshuman Atrey" came out as "Anshuman At".
  const spans = aggregateTokens([tok('Anshuman', 'B-PER'), tok('At', 'I-PER'), tok('##rey', 'O', 0.5)]);
  assert.deepEqual(spans.map((s) => s.text), ['Anshuman Atrey']);
});

test('a B- tag on a subtoken does not start a new span', () => {
  // Measured failure: "Amartya Sen" came out as "Amar" + "tya Sen".
  const spans = aggregateTokens([tok('Amar', 'B-PER'), tok('##tya', 'B-PER'), tok('Sen', 'I-PER')]);
  assert.deepEqual(spans.map((s) => s.text), ['Amartya Sen']);
});

test('tokenizer spacing around punctuation is undone', () => {
  const a = aggregateTokens([tok('Amazon', 'B-ORG'), tok('.', 'I-ORG'), tok('com', 'I-ORG')]);
  assert.equal(a[0].text, 'Amazon.com');
  const b = aggregateTokens([tok('Sixt', 'B-ORG'), tok('GmbH', 'I-ORG'), tok('&', 'I-ORG'), tok('Co', 'I-ORG'), tok('.', 'I-ORG'), tok('KG', 'I-ORG')]);
  assert.equal(b[0].text, 'Sixt GmbH & Co. KG');
  const c = aggregateTokens([tok('Lars', 'B-PER'), tok('-', 'I-PER'), tok('Eric', 'I-PER'), tok('Peters', 'I-PER')]);
  assert.equal(c[0].text, 'Lars-Eric Peters');
});

test('adjacent entities split on label change and on B-', () => {
  const spans = aggregateTokens([
    tok('Dirk', 'B-PER'), tok('Hünten', 'I-PER'), tok(',', 'O'),
    tok('Michael', 'B-PER'), tok('Knippel', 'I-PER'), tok('at', 'O'),
    tok('Sixt', 'B-ORG'),
  ]);
  assert.deepEqual(spans.map((s) => [s.label, s.text]), [['PER', 'Dirk Hünten'], ['PER', 'Michael Knippel'], ['ORG', 'Sixt']]);
});

test('score is the mean over the span', () => {
  const [s] = aggregateTokens([tok('Jason', 'B-PER', 1.0), tok('Fried', 'I-PER', 0.8)]);
  assert.ok(Math.abs(s.score - 0.9) < 1e-9);
});

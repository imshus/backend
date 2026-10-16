/**
 * The reader no longer writes unknownFields (16 Oct 2026). What the server
 * used that list for now comes from the transcript: a compact grade code the
 * reader could not split, and the prompt never asks for the list.
 * No real model call is made.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const openaiService = require('../src/services/openai.service');
const { getSystemPrompt } = require('../src/prompts/openai.prompt');

const { repairCompactGradeTokens } = openaiService._internal;

const empty = () => ({ value: '', confidence: 0 });
const stone = (fields = {}) => ({
  shape: empty(), color: empty(), clarity: empty(), weight: { value: '0.54', confidence: 95 }, ...fields,
});

test('the prompt no longer asks for unknownFields or a provider label', () => {
  assert.equal(getSystemPrompt().includes('unknownFields'), false);
  assert.equal(getSystemPrompt().includes('"provider"'), false);
});

test('a compact grade left unsplit is recovered from the transcript, for review', () => {
  const parsed = {
    rawText: { merged: 'DIA WT .54 PCEFGSI\nGR WT 8.208\nNET WT 8.100' },
    structuredData: { diamonds: [stone()] },
  };
  repairCompactGradeTokens(parsed, null);
  const row = parsed.structuredData.diamonds[0];
  assert.equal(row.shape.value, 'PC');
  assert.equal(row.clarity.value, 'SI');
  assert.equal(row.color.value, 'EFG');
  assert.equal(row.shape.confidence, 70);
});

test('a grade another row already carries is not copied onto an empty row', () => {
  const parsed = {
    rawText: { merged: 'RDEFVS 0.30\nDIA 0.24' },
    structuredData: {
      diamonds: [
        stone({ shape: { value: 'RD', confidence: 95 }, color: { value: 'EF', confidence: 95 }, clarity: { value: 'VS', confidence: 95 } }),
        stone(),
      ],
    },
  };
  repairCompactGradeTokens(parsed, null);
  assert.equal(parsed.structuredData.diamonds[1].shape.value, '');
});

test('ordinary words and codes in the transcript are not split into grades', () => {
  const parsed = {
    rawText: { merged: 'GR WT 13.838\nNET WT 13.672\nDIA WT .83\nSR NO 383818\nST NO D3883\nPrincess cut' },
    structuredData: { diamonds: [stone()] },
  };
  repairCompactGradeTokens(parsed, null);
  const row = parsed.structuredData.diamonds[0];
  assert.equal(row.shape.value, '');
  assert.equal(row.color.value, '');
  assert.equal(row.clarity.value, '');
});

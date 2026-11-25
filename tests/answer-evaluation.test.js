/**
 * Tests for deterministic answer, citation, and refusal scoring.
 * @module dsh-evidence-agent/tests/answer-evaluation
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkCitation,
  evaluateAnswers,
  formatAnswerReport,
  parseJudgements,
  parsePredictions,
} from '../lib/answer-evaluation.js'

const questions = [
  {
    id: 's1',
    type: 'single_hop',
    gold_doc_ids: ['doc-one'],
    gold_chunk_ids: ['doc-one-c001'],
  },
  {
    id: 'u1',
    type: 'unanswerable',
    gold_doc_ids: [],
    gold_chunk_ids: [],
  },
]

const chunksById = new Map([
  ['doc-one-c001', {
    doc_id: 'doc-one',
    chunk_id: 'doc-one-c001',
    line_start: 10,
    line_end: 20,
  }],
  ['doc-one-c002', {
    doc_id: 'doc-one',
    chunk_id: 'doc-one-c002',
    line_start: 21,
    line_end: 30,
  }],
])

test('citation overlap checks distinguish valid locators from gold support', () => {
  assert.deepEqual(
    checkCitation(
      { doc_id: 'doc-one', line_start: 12, line_end: 14 },
      questions[0],
      chunksById,
    ),
    { valid: true, supported: true },
  )
  assert.deepEqual(
    checkCitation(
      { doc_id: 'doc-one', line_start: 22, line_end: 24 },
      questions[0],
      chunksById,
    ),
    { valid: true, supported: false },
  )
  assert.deepEqual(
    checkCitation(
      { doc_id: 'missing', line_start: 1, line_end: 2 },
      questions[0],
      chunksById,
    ),
    { valid: false, supported: false },
  )
})

test('answer evaluation computes refusal, citation, and judged quality metrics', () => {
  const predictions = [
    {
      id: 's1',
      strategy: 'hybrid',
      answer: 'Supported answer.',
      citations: [{ doc_id: 'doc-one', line_start: 10, line_end: 12 }],
      abstained: false,
      latency_ms: 100,
      tool_calls: 2,
      input_tokens: 50,
      output_tokens: 10,
    },
    {
      id: 'u1',
      strategy: 'hybrid',
      answer: '根据当前知识库无法确认。',
      citations: [],
      abstained: true,
      latency_ms: 200,
      tool_calls: 1,
      input_tokens: 40,
      output_tokens: 8,
    },
  ]
  const judgements = [{
    id: 's1',
    strategy: 'hybrid',
    correct: true,
    faithful: true,
  }]
  const report = evaluateAnswers({
    questions,
    chunksById,
    predictions,
    judgements,
  })
  const hybrid = report.strategies.hybrid

  assert.equal(hybrid.answer_count, 2)
  assert.equal(hybrid.answer_accuracy, 1)
  assert.equal(hybrid.faithfulness, 1)
  assert.equal(hybrid.citation_gold_accuracy, 1)
  assert.equal(hybrid.citation_coverage, 1)
  assert.equal(hybrid.refusal_accuracy, 1)
  assert.equal(hybrid.false_refusal_rate, 0)
  assert.equal(hybrid.average_latency_ms, 150)
  assert.equal(hybrid.p95_latency_ms, 200)
  assert.equal(hybrid.average_evidence_tool_calls, null)
  assert.equal(hybrid.average_tool_calls, 1.5)
  assert.equal(hybrid.average_tokens, 54)
})

test('unjudged answers keep factual quality metrics unavailable', () => {
  const report = evaluateAnswers({
    questions,
    chunksById,
    predictions: [{
      id: 's1',
      strategy: 'agentic',
      answer: 'Unjudged answer.',
      citations: [],
      abstained: false,
    }],
  })
  const agentic = report.strategies.agentic

  assert.equal(agentic.answer_accuracy, null)
  assert.equal(agentic.faithfulness, null)
  assert.equal(agentic.citation_gold_accuracy, null)
  assert.equal(agentic.citation_coverage, 0)
  assert.deepEqual(agentic.missing_question_ids, ['u1'])
  assert.deepEqual(agentic.unjudged_answer_ids, ['s1'])
})

test('prediction parsing and answer report preserve limitations', () => {
  const parsed = parsePredictions(
    '{"id":"s1","strategy":"hybrid","answer":"x","citations":[],"abstained":false}\n',
  )
  assert.equal(parsed.length, 1)
  assert.equal(parseJudgements('').length, 0)

  const report = evaluateAnswers({
    questions,
    chunksById,
    predictions: parsed,
  })
  const markdown = formatAnswerReport(report)
  assert.match(markdown, /Answer correctness and faithfulness are N\/A/)
  assert.match(markdown, /\| hybrid \| 1\/2/)
})

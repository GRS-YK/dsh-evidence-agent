/**
 * Tests for the 60-question dataset and retrieval metric aggregation.
 * @module dsh-evidence-agent/tests/evaluation
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkMarkdown } from '../lib/chunker.js'
import {
  formatRetrievalReport,
  parseEvaluationDataset,
  scoreRanking,
  summarizeRetrievalRun,
} from '../lib/evaluation.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('evaluation dataset has the required size, balance, and real gold chunks', async () => {
  const documents = (await readFile(
    path.join(REPO_ROOT, 'knowledge', 'manifest.jsonl'),
    'utf8',
  )).trim().split(/\r?\n/).map(line => JSON.parse(line))
  const chunks = []
  for (const document of documents) {
    const markdown = await readFile(
      path.join(REPO_ROOT, document.canonical_path),
      'utf8',
    )
    chunks.push(...chunkMarkdown(markdown, {
      docId: document.doc_id,
      title: document.title,
    }))
  }
  const questions = parseEvaluationDataset(
    await readFile(path.join(REPO_ROOT, 'eval', 'questions.jsonl'), 'utf8'),
    { chunksById: new Map(chunks.map(chunk => [chunk.chunk_id, chunk])) },
  )

  assert.equal(questions.length, 60)
  assert.equal(questions.filter(question => question.type === 'single_hop').length, 35)
  assert.equal(questions.filter(question => question.type === 'multi_hop').length, 15)
  assert.equal(questions.filter(question => question.type === 'unanswerable').length, 10)
})

test('retrieval ranking scores any-hit recall and reciprocal rank', () => {
  assert.deepEqual(
    scoreRanking(['gold-a', 'gold-b'], ['other', 'gold-a', 'gold-b'], 5),
    {
      hit: true,
      recall: 1,
      reciprocal_rank: 1 / 2,
    },
  )
  assert.deepEqual(
    scoreRanking(['gold-a', 'gold-b'], ['other', 'gold-a'], 5),
    {
      hit: true,
      recall: 1 / 2,
      reciprocal_rank: 1 / 2,
    },
  )
  assert.deepEqual(
    scoreRanking(['gold'], ['other'], 5),
    {
      hit: false,
      recall: 0,
      reciprocal_rank: 0,
    },
  )
})

test('evaluation summary excludes unanswerable questions from retrieval quality', () => {
  const questions = [
    { id: 's1', type: 'single_hop', gold_chunk_ids: ['gold'] },
    { id: 'm1', type: 'multi_hop', gold_chunk_ids: ['gold-a', 'gold-b'] },
    { id: 'u1', type: 'unanswerable', gold_chunk_ids: [] },
  ]
  const summary = summarizeRetrievalRun({
    questions,
    topK: 5,
    runs: {
      s1: {
        hits: [{ chunk_id: 'gold' }],
        latencyMs: 10,
        evidenceCalls: 1,
      },
      m1: {
        hits: [{ chunk_id: 'gold-a' }, { chunk_id: 'other' }],
        latencyMs: 20,
        evidenceCalls: 2,
      },
      u1: {
        hits: [{ chunk_id: 'unsupported-candidate' }],
        latencyMs: 30,
        evidenceCalls: 1,
      },
    },
  })

  assert.equal(summary.recall_at_k, (1 + 0.5) / 2)
  assert.equal(summary.hit_rate_at_k, 1)
  assert.equal(summary.mrr_at_k, 1)
  assert.equal(summary.unanswerable_evidence_return_rate, 1)
  assert.equal(summary.average_search_ms, 20)
  assert.equal(summary.average_evidence_calls, 4 / 3)
})

test('Markdown report keeps retrieval-only limitations visible', () => {
  const report = {
    generated_at: '2026-11-25T00:00:00.000Z',
    notes: ['> Retrieval only.'],
    strategies: {
      no_rag: {
        description: 'baseline',
      },
      hybrid: {
        recall_at_k: 0.8,
        hit_rate_at_k: 0.9,
        mrr_at_k: 0.7,
        unanswerable_evidence_return_rate: 0.4,
        average_search_ms: 12,
        average_evidence_calls: 1,
        by_type: {
          single_hop: {
            count: 2,
            recall_at_k: 0.8,
            hit_rate_at_k: 0.9,
            mrr_at_k: 0.7,
          },
          multi_hop: {
            count: 1,
            recall_at_k: 0.7,
            hit_rate_at_k: 1,
            mrr_at_k: 0.6,
          },
          unanswerable: {
            count: 1,
            recall_at_k: null,
            hit_rate_at_k: null,
            mrr_at_k: null,
          },
        },
      },
    },
  }

  const markdown = formatRetrievalReport(report)
  assert.match(markdown, /Retrieval only/)
  assert.match(markdown, /\| No RAG \| N\/A/)
  assert.match(markdown, /\| hybrid \| 0\.8000/)
  assert.match(markdown, /## By question type/)
})

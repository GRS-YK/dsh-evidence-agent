/**
 * Tests for dense retrieval and dense + lexical RRF fusion.
 * @module dsh-evidence-agent/tests/retrieval
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBM25Index } from '../lib/bm25.js'
import {
  cosineSimilarity,
  hybridSearch,
  rrfFuse,
  searchDense,
} from '../lib/retrieval.js'

function chunk(chunkId, text, overrides = {}) {
  return {
    doc_id: overrides.doc_id ?? 'example-doc',
    chunk_id: chunkId,
    document_title: overrides.document_title ?? 'Example',
    section: overrides.section ?? 'Search',
    heading_path: overrides.heading_path ?? ['Example', 'Search'],
    section_line: overrides.section_line ?? 1,
    line_start: overrides.line_start ?? 1,
    line_end: overrides.line_end ?? 3,
    text,
  }
}

function vectorRecord(chunkValue, embedding) {
  return {
    ...chunkValue,
    embedding,
    source_url: `https://example.test/${chunkValue.chunk_id}`,
    canonical_path: `knowledge/canonical/${chunkValue.doc_id}.md`,
    license: 'MIT',
  }
}

test('cosine similarity scores aligned vectors and rejects invalid input', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1)
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  assert.ok(Math.abs(cosineSimilarity([1, 0], [1, 1]) - Math.SQRT1_2) < 1e-12)

  assert.throws(() => cosineSimilarity([1], [1, 2]), /same dimension/)
  assert.throws(() => cosineSimilarity([0, 0], [1, 0]), /zero magnitude/)
  assert.throws(() => cosineSimilarity([1, Number.NaN], [1, 0]), /invalid value/)
  assert.throws(() => cosineSimilarity([], []), /non-empty array/)
})

test('dense search ranks by cosine score and preserves source metadata', () => {
  const records = [
    vectorRecord(chunk('doc-c001', 'first'), [1, 0]),
    vectorRecord(chunk('doc-c002', 'second'), [0.8, 0.2]),
    vectorRecord(chunk('doc-c003', 'third'), [0, 1]),
  ]
  const results = searchDense(records, [1, 0], { topK: 2 })

  assert.deepEqual(results.map(result => result.chunk_id), ['doc-c001', 'doc-c002'])
  assert.ok(results[0].score > results[1].score)
  assert.match(results[0].source_url, /doc-c001/)
})

test('RRF rewards chunks appearing in both ranked lists', () => {
  const results = rrfFuse([
    {
      source: 'dense',
      results: [
        { chunk_id: 'only-dense', score: 0.9 },
        { chunk_id: 'shared', score: 0.8 },
      ],
    },
    {
      source: 'lexical',
      results: [
        { chunk_id: 'shared', score: 5, matched_terms: ['rrf'] },
        { chunk_id: 'only-lexical', score: 4, matched_terms: ['bm25'] },
      ],
    },
  ], { rankConstant: 60, topK: 3 })

  assert.equal(results[0].chunk_id, 'shared')
  assert.deepEqual(results[0].ranks, { dense: 2, lexical: 1 })
  assert.deepEqual(results[0].scores, { dense: 0.8, lexical: 5 })
  assert.equal(results[0].rrf_score, 1 / 62 + 1 / 61)
  assert.deepEqual(results[0].matched_terms, ['rrf'])
})

test('RRF validates sources, duplicates, weights, and limits', () => {
  assert.throws(
    () => rrfFuse([{ source: 'dense', results: [{ chunk_id: 'same' }, { chunk_id: 'same' }] }]),
    /duplicate dense result/,
  )
  assert.throws(
    () => rrfFuse([
      { source: 'dense', results: [] },
      { source: 'dense', results: [] },
    ]),
    /duplicate ranked-list source/,
  )
  assert.throws(
    () => rrfFuse([{ source: 'dense', results: [], weight: -1 }]),
    /non-negative/,
  )
  assert.throws(
    () => rrfFuse([{ source: 'dense', results: [] }], { rankConstant: 0 }),
    /rankConstant/,
  )
})

test('hybrid search fuses lexical and semantic winners into a common chunk', () => {
  const chunks = [
    chunk('doc-c001', 'semantic close but no keyword'),
    chunk('doc-c002', 'alpha lexical only'),
    chunk('doc-c003', 'alpha shared'),
  ]
  const bm25Index = buildBM25Index({ chunks })
  const vectorRecords = [
    vectorRecord(chunks[0], [1, 0]),
    vectorRecord(chunks[1], [0, 1]),
    vectorRecord(chunks[2], [0.7, 0.7]),
  ]

  const { results, diagnostics } = hybridSearch({
    bm25Index,
    vectorRecords,
    query: 'alpha',
    queryEmbedding: [0.8, 0.2],
    candidateK: 3,
    topK: 3,
  })

  assert.equal(results[0].chunk_id, 'doc-c003')
  assert.equal(results[0].ranks.lexical, 1)
  assert.equal(results[0].ranks.dense, 2)
  assert.deepEqual(diagnostics, {
    dense_candidates: 3,
    lexical_candidates: 2,
    rank_constant: 60,
    dense_weight: 1,
    lexical_weight: 1,
  })
})

test('hybrid search keeps dense candidates when BM25 has no match', () => {
  const chunks = [chunk('doc-c001', 'alpha')]
  const bm25Index = buildBM25Index({
    chunks: [chunk('other-c001', 'unrelated lexical content')],
  })
  const { results } = hybridSearch({
    bm25Index,
    vectorRecords: [vectorRecord(chunks[0], [1, 0])],
    query: 'never-present-term',
    queryEmbedding: [1, 0],
    candidateK: 2,
    topK: 2,
  })

  // Dense retrieval still supplies a recoverable candidate when BM25 is empty.
  assert.equal(results.length, 1)
  assert.equal(results[0].chunk_id, 'doc-c001')
  assert.equal(results[0].ranks.dense, 1)
  assert.equal(results[0].ranks.lexical, undefined)
})

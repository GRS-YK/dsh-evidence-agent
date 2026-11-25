/**
 * Tests for bounded evidence search, reads, and source listing.
 * @module dsh-evidence-agent/tests/evidence-query
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildBM25Index } from '../lib/bm25.js'
import {
  listPrepared,
  readPrepared,
  searchPrepared,
} from '../lib/evidence-query.js'

function chunk(chunkId, text, overrides = {}) {
  return {
    doc_id: overrides.doc_id ?? 'doc-one',
    chunk_id: chunkId,
    document_title: overrides.document_title ?? 'Document One',
    section: overrides.section ?? 'Search',
    heading_path: overrides.heading_path ?? ['Document One', 'Search'],
    section_line: overrides.section_line ?? 1,
    line_start: overrides.line_start ?? 1,
    line_end: overrides.line_end ?? 3,
    text,
  }
}

function corpusFor(chunks) {
  const documents = [
    {
      doc_id: 'doc-one',
      title: 'Document One',
      source_format: 'Markdown',
      source_url: 'https://example.test/one',
      license: 'MIT',
      retrieval_date: '2026-11-25',
      canonical_path: 'knowledge/canonical/one.md',
    },
  ]
  return {
    documents,
    chunks,
    metadataByDocId: {
      'doc-one': documents[0],
    },
  }
}

test('prepared lexical search returns schema-shaped hits and line references', () => {
  const chunks = [
    chunk('doc-one-c001', 'Alpha lexical retrieval details.'),
    chunk('doc-one-c002', 'Beta vector evaluation details.'),
  ]
  const bm25Index = buildBM25Index({ chunks })
  const result = searchPrepared({
    query: 'alpha',
    mode: 'lexical',
    topK: 1,
    bm25Index,
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.mode, 'lexical')
  assert.equal(result.hits[0].doc_id, 'doc-one')
  assert.equal(result.hits[0].chunk_id, 'doc-one-c001')
  assert.equal(result.hits[0].score_kind, 'bm25')
  assert.equal(result.hits[0].line_start, 1)
  assert.equal(result.hits[0].line_end, 3)
})

test('prepared hybrid search keeps scores and metadata inside the text budget', () => {
  const chunks = [
    chunk('doc-one-c001', 'Alpha lexical text.'),
    chunk('doc-one-c002', 'Alpha semantic text.'),
  ]
  const bm25Index = buildBM25Index({ chunks })
  const vectorRecords = [
    { ...chunks[0], embedding: [1, 0], source_url: 'https://example.test/one' },
    { ...chunks[1], embedding: [0, 1], source_url: 'https://example.test/two' },
  ]
  const result = searchPrepared({
    query: 'alpha',
    mode: 'hybrid',
    topK: 2,
    bm25Index,
    vectorRecords,
    queryEmbedding: [0.8, 0.2],
    maxChars: 200,
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.mode, 'hybrid')
  assert.ok(result.hits.some(hit => hit.score_kind === 'rrf'))
  assert.ok(result.hits.every(hit => hit.text.length <= 200))
})

test('hybrid search degrades to lexical when dense retrieval is absent', () => {
  const chunks = [chunk('doc-one-c001', 'Alpha lexical fallback.')]
  const result = searchPrepared({
    query: 'alpha',
    mode: 'hybrid',
    bm25Index: buildBM25Index({ chunks }),
  })

  assert.equal(result.status, 'degraded')
  assert.equal(result.mode, 'lexical')
  assert.match(result.notice, /degraded to BM25/)
  assert.equal(result.hits[0].chunk_id, 'doc-one-c001')
})

test('search text truncation and invalid inputs are explicit', () => {
  const longText = `alpha ${'中'.repeat(500)}`
  const chunks = [chunk('doc-one-c001', longText)]
  const result = searchPrepared({
    query: 'alpha',
    mode: 'lexical',
    bm25Index: buildBM25Index({ chunks }),
    maxChars: 200,
  })

  assert.equal(result.truncated, true)
  assert.equal(Array.from(result.hits[0].text).length, 200)
  assert.match(result.notice, /character budget/)
  assert.throws(
    () => searchPrepared({ query: '', bm25Index: buildBM25Index({ chunks }) }),
    /non-empty string/,
  )
  assert.throws(
    () => searchPrepared({ query: 'alpha', topK: 11, bm25Index: buildBM25Index({ chunks }) }),
    /top_k/,
  )
})

test('contextual read returns neighbours and a continuation ID', () => {
  const corpus = corpusFor([
    chunk('doc-one-c001', 'First context.', { line_start: 1, line_end: 2 }),
    chunk('doc-one-c002', 'Selected context.', { line_start: 3, line_end: 4 }),
    chunk('doc-one-c003', 'Final context.', { line_start: 5, line_end: 6 }),
  ])
  const result = readPrepared({
    corpus,
    metadataByDocId: corpus.metadataByDocId,
    docId: 'doc-one',
    chunkId: 'doc-one-c002',
    neighborCount: 1,
  })

  assert.equal(result.status, 'ok')
  assert.deepEqual(result.selected_chunks.map(chunk => chunk.chunk_id), [
    'doc-one-c001',
    'doc-one-c002',
    'doc-one-c003',
  ])
  assert.equal(result.document.chunk_count, 3)
  assert.equal(result.document.page_count, null)
  assert.equal(result.next_chunk_id, undefined)
})

test('oversized read windows retain only the bounded center chunk', () => {
  const corpus = corpusFor([
    chunk('doc-one-c001', 'a'.repeat(500)),
    chunk('doc-one-c002', 'b'.repeat(500)),
    chunk('doc-one-c003', 'c'.repeat(500)),
  ])
  const result = readPrepared({
    corpus,
    metadataByDocId: corpus.metadataByDocId,
    docId: 'doc-one',
    chunkId: 'doc-one-c002',
    neighborCount: 1,
    maxChars: 200,
  })

  assert.equal(result.status, 'truncated')
  assert.equal(result.truncated, true)
  assert.deepEqual(result.selected_chunks.map(chunk => chunk.chunk_id), ['doc-one-c002'])
  assert.equal(Array.from(result.selected_chunks[0].text).length, 200)
  assert.equal(result.next_chunk_id, 'doc-one-c003')
})

test('missing reads and bounded source lists remain recoverable', () => {
  const corpus = corpusFor([
    chunk('doc-one-c001', 'First.'),
    chunk('doc-one-c002', 'Second.'),
  ])
  const missing = readPrepared({
    corpus,
    metadataByDocId: corpus.metadataByDocId,
    docId: 'doc-one',
    chunkId: 'missing',
  })
  assert.equal(missing.status, 'not_found')
  assert.deepEqual(missing.selected_chunks, [])

  const list = listPrepared({ corpus, limit: 1 })
  assert.equal(list.status, 'ok')
  assert.equal(list.total, 1)
  assert.equal(list.documents[0].chunk_count, 2)
  assert.equal(list.truncated, false)
})

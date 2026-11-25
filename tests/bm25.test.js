/**
 * Tests for mixed-language BM25 tokenization, indexing, and persistence.
 * @module dsh-evidence-agent/tests/bm25
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildBM25Index,
  parseBM25Index,
  searchBM25,
  serializeBM25Index,
  tokenize,
} from '../lib/bm25.js'
import { chunkMarkdown } from '../lib/chunker.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

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

test('tokenizer handles English normalization and Chinese character n-grams', () => {
  const tokens = tokenize('BM25，混合检索 Retrieval_Test')

  assert.ok(tokens.includes('w:bm25'))
  assert.ok(tokens.includes('c:混'))
  assert.ok(tokens.includes('g:混合'))
  assert.ok(tokens.includes('g:检索'))
  assert.ok(tokens.includes('w:retrieval'))
  assert.ok(tokens.includes('w:test'))
  assert.deepEqual(tokenize('，。！ '), [])
  assert.throws(() => tokenize(null), /text must be a string/)
})

test('BM25 ranks the chunk containing both distinctive query terms first', () => {
  const index = buildBM25Index({
    chunks: [
      chunk('doc-c001', 'General retrieval documentation about vectors.'),
      chunk('doc-c002', 'RRF combines BM25 and dense retrieval rankings.'),
      chunk('doc-c003', 'BM25 alone uses lexical term frequencies.'),
    ],
  })

  const results = searchBM25(index, 'RRF BM25', { topK: 3 })
  assert.ok(results.length >= 2)
  assert.equal(results[0].chunk_id, 'doc-c002')
  assert.ok(results[0].score > results[1].score)
  assert.deepEqual(results[0].matched_terms.sort(), ['bm25', 'rrf'])
})

test('Chinese queries retrieve semantically corresponding n-grams', () => {
  const index = buildBM25Index({
    chunks: [
      chunk('chinese-c001', '系统使用混合检索融合关键词和向量召回结果。'),
      chunk('chinese-c002', '评测脚本统计 Recall@5 和平均延迟。'),
    ],
  })

  const results = searchBM25(index, '混合检索')
  assert.equal(results.length, 1)
  assert.equal(results[0].chunk_id, 'chinese-c001')
  assert.ok(results[0].matched_terms.includes('混合'))
  assert.ok(results[0].matched_terms.includes('检索'))
})

test('index persistence is deterministic and preserves source metadata', () => {
  const chunks = [
    chunk('doc-c001', 'First searchable chunk.'),
    chunk('doc-c002', 'Second searchable chunk.'),
  ]
  const metadataByDocId = {
    'example-doc': {
      source_url: 'https://example.test/source',
      canonical_path: 'knowledge/canonical/example.md',
      license: 'MIT',
    },
  }
  const first = buildBM25Index({ chunks, metadataByDocId })
  const second = buildBM25Index({ chunks, metadataByDocId })
  const serialized = serializeBM25Index(first)

  assert.deepEqual(second, first)
  assert.deepEqual(parseBM25Index(serialized), first)
  assert.equal(first.documents[0].source_url, 'https://example.test/source')
  assert.equal(first.documents[0].canonical_path, 'knowledge/canonical/example.md')
})

test('invalid or corrupted indexes fail with useful diagnostics', () => {
  assert.throws(() => parseBM25Index('{bad json}'), /Invalid BM25 index JSON/)
  assert.throws(() => buildBM25Index({ chunks: [] }), /non-empty array/)
  assert.throws(
    () => buildBM25Index({ chunks: [chunk('dup', 'one'), chunk('dup', 'two')] }),
    /duplicate chunk_id/,
  )
  assert.throws(
    () => buildBM25Index({ chunks: [chunk('doc-c001', 'valid')], k1: 0 }),
    /k1/,
  )

  const index = buildBM25Index({ chunks: [chunk('doc-c001', 'searchable content')] })
  const corrupted = structuredClone(index)
  corrupted.documents[0].length += 1
  assert.throws(
    () => parseBM25Index(JSON.stringify(corrupted)),
    /Token length mismatch/,
  )
})

test('real canonical corpus produces useful BM25 rankings', async () => {
  const documents = (await readFile(
    path.join(REPO_ROOT, 'knowledge', 'manifest.jsonl'),
    'utf8',
  )).trim().split('\n').map(line => JSON.parse(line))
  const chunks = []
  const metadataByDocId = {}

  for (const document of documents) {
    const markdown = await readFile(path.join(REPO_ROOT, document.canonical_path), 'utf8')
    chunks.push(...chunkMarkdown(markdown, {
      docId: document.doc_id,
      title: document.title,
    }))
    metadataByDocId[document.doc_id] = document
  }

  const index = buildBM25Index({ chunks, metadataByDocId })
  assert.equal(index.chunk_count, 78)
  assert.ok(Object.keys(index.document_frequencies).length > 1_000)

  const bm25Results = searchBM25(index, 'BM25Okapi', { topK: 5 })
  assert.ok(bm25Results.length > 0)
  assert.equal(bm25Results[0].doc_id, 'rank-bm25')

  const rrfResults = searchBM25(index, 'reciprocal rank fusion', { topK: 5 })
  assert.ok(rrfResults.some(result => result.doc_id === 'milvus-rrf-ranker'))
})

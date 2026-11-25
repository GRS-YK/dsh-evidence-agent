/**
 * Tests for vector record construction and JSONL persistence.
 * @module dsh-evidence-agent/tests/vector-store
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkMarkdown } from '../lib/chunker.js'
import { sha256 } from '../lib/knowledge-manifest.js'
import {
  buildVectorRecords,
  isVectorRecordReusable,
  parseVectorIndex,
  serializeVectorIndex,
} from '../lib/vector-store.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function chunk(id) {
  return {
    doc_id: 'example-doc',
    chunk_id: id,
    document_title: 'Example',
    section: 'Install',
    heading_path: ['Example', 'Install'],
    section_line: 1,
    line_start: 1,
    line_end: 5,
    token_count: 5,
    char_count: 10,
    text: `text for ${id}`,
  }
}

test('vector records preserve chunk metadata, hashes, and source information', () => {
  const chunks = [chunk('example-doc-c001'), chunk('example-doc-c002')]
  const records = buildVectorRecords({
    chunks,
    vectors: [[0.1, 0.2], [0.3, 0.4]],
    model: 'BAAI/bge-m3',
    dimension: 2,
    metadataByDocId: {
      'example-doc': {
        source_url: 'https://example.test/source.md',
        canonical_path: 'knowledge/canonical/source.md',
        license: 'MIT',
      },
    },
  })

  assert.equal(records.length, 2)
  assert.equal(records[0].text_sha256, sha256(chunks[0].text))
  assert.equal(records[0].source_url, 'https://example.test/source.md')
  assert.deepEqual(records[1].embedding, [0.3, 0.4])
  assert.equal(records[1].embedding_dimension, 2)
})

test('JSONL serialization round-trips and duplicate records are rejected', () => {
  const chunks = [chunk('example-doc-c001'), chunk('example-doc-c002')]
  const records = buildVectorRecords({
    chunks,
    vectors: [[0.1, 0.2], [0.3, 0.4]],
    model: 'BAAI/bge-m3',
    dimension: 2,
  })
  const serialized = serializeVectorIndex(records)

  assert.equal(serialized.trimEnd().split('\n').length, 2)
  assert.deepEqual(parseVectorIndex(serialized), records)

  assert.throws(
    () => buildVectorRecords({
      chunks: [chunk('duplicate'), chunk('duplicate')],
      vectors: [[0.1], [0.2]],
      model: 'model',
      dimension: 1,
    }),
    /duplicate chunk_id/,
  )
  assert.throws(
    () => parseVectorIndex(`${JSON.stringify(records[0])}\n${JSON.stringify(records[0])}\n`),
    /Duplicate chunk_id/,
  )
})

test('vectors can only be reused when content, model, and dimension match', () => {
  const currentChunk = chunk('example-doc-c001')
  const record = buildVectorRecords({
    chunks: [currentChunk],
    vectors: [[0.1, 0.2]],
    model: 'BAAI/bge-m3',
    dimension: 2,
  })[0]

  assert.equal(isVectorRecordReusable(record, currentChunk, 'BAAI/bge-m3', 2), true)
  assert.equal(isVectorRecordReusable(record, currentChunk, 'other-model', 2), false)
  assert.equal(isVectorRecordReusable(record, currentChunk, 'BAAI/bge-m3', 3), false)
  assert.equal(
    isVectorRecordReusable(
      record,
      { ...currentChunk, text: 'changed content' },
      'BAAI/bge-m3',
      2,
    ),
    false,
  )
  assert.equal(isVectorRecordReusable(record, undefined, 'BAAI/bge-m3', 2), false)
})

test('invalid records fail with line or dimension diagnostics', () => {
  assert.throws(
    () => parseVectorIndex('{bad json}\n'),
    /line 1/,
  )
  assert.throws(
    () => buildVectorRecords({
      chunks: [chunk('example-doc-c001')],
      vectors: [[0.1]],
      model: 'model',
      dimension: 2,
    }),
    /exactly 2 numbers/,
  )
  assert.throws(
    () => parseVectorIndex(`${JSON.stringify({
      chunk_id: 'bad',
      embedding_dimension: 2,
      embedding: [0.1],
    })}\n`),
    /exactly 2 numbers/,
  )
})

test('all canonical chunks can be combined with dense test vectors', async () => {
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

  const vectors = chunks.map((_, chunkIndex) => (
    Array.from({ length: 4 }, (_, valueIndex) => (chunkIndex + valueIndex + 1) / 100)
  ))
  const records = buildVectorRecords({
    chunks,
    vectors,
    model: 'BAAI/bge-m3',
    dimension: 4,
    metadataByDocId,
  })

  assert.equal(records.length, chunks.length)
  assert.ok(records.length >= 70)
  assert.equal(new Set(records.map(record => record.chunk_id)).size, records.length)
  assert.equal(parseVectorIndex(serializeVectorIndex(records)).length, records.length)
})

/**
 * Integration tests for the filesystem-backed evidence service.
 * @module dsh-evidence-agent/tests/evidence-service
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EvidenceService } from '../lib/evidence-service.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function createService(overrides = {}) {
  return new EvidenceService({
    repoRoot: REPO_ROOT,
    environment: {},
    loadEnv: false,
    ...overrides,
  })
}

test('service performs lexical search from disk or an in-memory fallback', async () => {
  const service = createService()
  const result = await service.search({
    query: 'BM25Okapi',
    mode: 'lexical',
    topK: 3,
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.mode, 'lexical')
  assert.equal(result.hits[0].doc_id, 'rank-bm25')
  assert.ok(result.hits[0].line_start <= result.hits[0].line_end)
})

test('service lists the committed source set', async () => {
  const service = createService()
  const result = await service.listSources({ limit: 3 })

  assert.equal(result.status, 'ok')
  assert.equal(result.total, 8)
  assert.equal(result.documents.length, 3)
  assert.equal(result.truncated, true)
  assert.ok(result.documents.every(document => document.chunk_count > 0))
})

test('service reads a real chunk with source metadata', async () => {
  const service = createService()
  const result = await service.read({
    docId: 'dsh-first-plugin',
    chunkId: 'dsh-first-plugin-c001',
    neighborCount: 1,
  })

  assert.equal(result.status, 'ok')
  assert.equal(result.document.doc_id, 'dsh-first-plugin')
  assert.ok(result.selected_chunks.length >= 1)
  assert.match(result.selected_chunks[0].text, /plugin/i)
})

test('hybrid search degrades to lexical without an embedding key', async () => {
  const service = createService()
  const result = await service.search({
    query: 'BM25Okapi',
    mode: 'hybrid',
    topK: 2,
  })

  assert.equal(result.mode, 'lexical')
  assert.equal(result.status, 'degraded')
  assert.match(result.notice, /EMBEDDING_API_KEY|dense retrieval was unavailable/)
  assert.ok(result.hits.length > 0)
})

test('service timeout returns an unavailable result instead of crashing', async () => {
  const service = createService({
    searchTimeoutMs: 10,
    readFileImpl: async (_file, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        'abort',
        () => reject(options.signal.reason),
        { once: true },
      )
    }),
  })
  const result = await service.search({ query: 'anything' })

  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.hits, [])
  assert.match(result.notice, /timed out after 10 ms/)
})

test('caller cancellation propagates instead of becoming a successful result', async () => {
  const controller = new AbortController()
  const reason = new DOMException('cancelled by agent', 'AbortError')
  const service = createService({
    readFileImpl: async (_file, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), {
        once: true,
      })
    }),
  })
  const pending = service.search({ query: 'anything', signal: controller.signal })
  controller.abort(reason)

  await assert.rejects(pending, error => error === reason)
})

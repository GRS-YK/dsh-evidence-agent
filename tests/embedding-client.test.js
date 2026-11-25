/**
 * Tests for the OpenAI-compatible embedding client.
 * @module dsh-evidence-agent/tests/embedding-client
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EmbeddingError,
  createOpenAICompatibleEmbeddingClient,
  validateEmbeddingResponse,
} from '../lib/embedding-client.js'

function successfulResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { data }
    },
    async text() {
      return ''
    },
  }
}

test('embedding client sends a compatible request and restores input order', async () => {
  let request
  const client = createOpenAICompatibleEmbeddingClient({
    baseUrl: 'https://example.test/v1/',
    apiKey: 'secret-key',
    model: 'BAAI/bge-m3',
    dimension: 3,
    fetchImpl: async (url, options) => {
      request = { url, options }
      return successfulResponse([
        { index: 1, embedding: [0.4, 0.5, 0.6] },
        { index: 0, embedding: [0.1, 0.2, 0.3] },
      ])
    },
  })

  const vectors = await client.embed(['first', 'second'])
  assert.deepEqual(vectors, [
    [0.1, 0.2, 0.3],
    [0.4, 0.5, 0.6],
  ])
  assert.equal(request.url, 'https://example.test/v1/embeddings')
  assert.equal(request.options.method, 'POST')
  assert.equal(request.options.headers.Authorization, 'Bearer secret-key')
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'BAAI/bge-m3',
    input: ['first', 'second'],
  })
})

test('transient HTTP failures are retried with exponential backoff', async () => {
  const calls = []
  const delays = []
  const client = createOpenAICompatibleEmbeddingClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret-key',
    model: 'embedding-model',
    dimension: 2,
    maxRetries: 2,
    retryDelayMs: 10,
    sleep: async milliseconds => delays.push(milliseconds),
    fetchImpl: async () => {
      calls.push('request')
      if (calls.length === 1) {
        return {
          ok: false,
          status: 429,
          async text() {
            return 'rate limited'
          },
        }
      }
      if (calls.length === 2) {
        return {
          ok: false,
          status: 503,
          async text() {
            return 'temporarily unavailable'
          },
        }
      }
      return successfulResponse([{ index: 0, embedding: [0.25, 0.75] }])
    },
  })

  assert.deepEqual(await client.embed(['hello']), [[0.25, 0.75]])
  assert.equal(calls.length, 3)
  assert.deepEqual(delays, [10, 20])
})

test('authentication errors are not retried', async () => {
  let calls = 0
  const client = createOpenAICompatibleEmbeddingClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'bad-key',
    model: 'embedding-model',
    dimension: 2,
    maxRetries: 3,
    sleep: async () => {},
    fetchImpl: async () => {
      calls++
      return {
        ok: false,
        status: 401,
        async text() {
          return 'invalid api key'
        },
      }
    },
  })

  await assert.rejects(
    () => client.embed(['hello']),
    error => error instanceof EmbeddingError && error.status === 401,
  )
  assert.equal(calls, 1)
})

test('response count, indexes, dimensions, and values are validated', () => {
  assert.throws(
    () => validateEmbeddingResponse({ data: [] }, 1, 2),
    /count mismatch/,
  )
  assert.throws(
    () => validateEmbeddingResponse({
      data: [
        { index: 0, embedding: [1, 2] },
        { index: 0, embedding: [3, 4] },
      ],
    }, 2, 2),
    /duplicate indexes/,
  )
  assert.throws(
    () => validateEmbeddingResponse({
      data: [{ index: 0, embedding: [1, 2, 3] }],
    }, 1, 2),
    /dimension mismatch/,
  )
  assert.throws(
    () => validateEmbeddingResponse({
      data: [{ index: 0, embedding: [1, Number.NaN] }],
    }, 1, 2),
    /invalid value/,
  )
})

test('invalid client configuration and empty batches fail early', async () => {
  assert.throws(
    () => createOpenAICompatibleEmbeddingClient({
      baseUrl: 'https://example.test/v1/embeddings',
      apiKey: 'key',
      model: 'model',
      dimension: 2,
    }),
    /must not include/,
  )

  const client = createOpenAICompatibleEmbeddingClient({
    baseUrl: 'https://example.test/v1',
    apiKey: 'key',
    model: 'model',
    dimension: 2,
    fetchImpl: async () => successfulResponse([]),
  })
  await assert.rejects(() => client.embed([]), /non-empty array/)
})

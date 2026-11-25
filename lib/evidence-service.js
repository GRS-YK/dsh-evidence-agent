/**
 * Runtime evidence service that loads local indexes and coordinates retrieval.
 * @module dsh-evidence-agent/lib/evidence-service
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  buildBM25Index,
  corpusFingerprint,
  parseBM25Index,
} from './bm25.js'
import { chunkMarkdown } from './chunker.js'
import {
  EvidenceInputError,
  EvidenceUnavailableError,
} from './evidence-errors.js'
import {
  DEFAULT_READ_CHARACTERS,
  DEFAULT_SEARCH_CHARACTERS,
  listPrepared,
  readPrepared,
  searchPrepared,
  unavailableRead,
  unavailableSearch,
  unavailableSourceList,
} from './evidence-query.js'
import { createOpenAICompatibleEmbeddingClient } from './embedding-client.js'
import { loadLocalEnv } from './local-env.js'
import { sha256 } from './knowledge-manifest.js'
import { parseVectorIndex } from './vector-store.js'

export class EvidenceService {
  /**
   * @param {object} options - service options.
   * @param {string} options.repoRoot - plugin repository root.
   * @param {NodeJS.ProcessEnv} [options.environment] - environment variables.
   * @param {boolean} [options.loadEnv=true] - load `<repoRoot>/.env`.
   * @param {Function} [options.readFileImpl] - injectable file reader.
   * @param {Function} [options.embeddingClientFactory] - injectable client factory.
   * @param {number} [options.searchTimeoutMs=15000] - search deadline.
   * @param {number} [options.readTimeoutMs=5000] - read/list deadline.
   * @param {number} [options.maxSearchChars] - search text budget.
   * @param {number} [options.maxReadChars] - read text budget.
   */
  constructor({
    repoRoot,
    environment = process.env,
    loadEnv = true,
    readFileImpl = readFile,
    embeddingClientFactory = createOpenAICompatibleEmbeddingClient,
    searchTimeoutMs = 15_000,
    readTimeoutMs = 5_000,
    maxSearchChars = DEFAULT_SEARCH_CHARACTERS,
    maxReadChars = DEFAULT_READ_CHARACTERS,
  }) {
    if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
      throw new TypeError('repoRoot must be a non-empty string')
    }

    this.repoRoot = path.resolve(repoRoot)
    this.environment = environment
    this.readFileImpl = readFileImpl
    this.embeddingClientFactory = embeddingClientFactory
    this.searchTimeoutMs = positiveInteger(searchTimeoutMs, 'searchTimeoutMs')
    this.readTimeoutMs = positiveInteger(readTimeoutMs, 'readTimeoutMs')
    this.maxSearchChars = characterBudget(maxSearchChars, 'maxSearchChars')
    this.maxReadChars = characterBudget(maxReadChars, 'maxReadChars')
    this.corpusPromise = null
    this.bm25Promise = null
    this.vectorPromise = null
    this.embeddingClient = null

    if (loadEnv) loadLocalEnv(path.join(this.repoRoot, '.env'))
  }

  /**
   * Search the knowledge base with hybrid, dense, or lexical retrieval.
   * @param {object} options - search options.
   * @param {string} options.query - user query.
   * @param {string} [options.mode='hybrid'] - retrieval mode.
   * @param {number} [options.topK=5] - maximum hits.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<object>} bounded structured result.
   */
  async search({ query, mode = 'hybrid', topK = 5, signal }) {
    const deadline = createDeadlineSignal(signal, this.searchTimeoutMs, 'Knowledge search')
    const warnings = []

    try {
      throwIfAborted(signal)
      const corpus = await this.getCorpus(deadline.signal)
      const bm25State = await this.getBm25Index(corpus, deadline.signal)
      if (bm25State.warning) warnings.push(bm25State.warning)

      if (mode === 'lexical') {
        return searchPrepared({
          query,
          mode,
          topK,
          bm25Index: bm25State.index,
          maxChars: this.maxSearchChars,
          warnings,
        })
      }

      let vectorRecords
      try {
        vectorRecords = await this.getVectorRecords(corpus, deadline.signal)
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal)
        if (error instanceof EvidenceInputError) throw error
        warnings.push(recoverableNotice(error))
        return searchPrepared({
          query,
          mode,
          topK,
          bm25Index: bm25State.index,
          vectorRecords: null,
          queryEmbedding: null,
          maxChars: this.maxSearchChars,
          warnings,
        })
      }

      let queryEmbedding
      try {
        const client = this.getEmbeddingClient()
        ;[queryEmbedding] = await client.embed([query], { signal: deadline.signal })
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal)
        if (error instanceof EvidenceInputError) throw error
        warnings.push(recoverableNotice(error))
        return searchPrepared({
          query,
          mode,
          topK,
          bm25Index: bm25State.index,
          vectorRecords: null,
          queryEmbedding: null,
          maxChars: this.maxSearchChars,
          warnings,
        })
      }

      return searchPrepared({
        query,
        mode,
        topK,
        bm25Index: bm25State.index,
        vectorRecords,
        queryEmbedding,
        maxChars: this.maxSearchChars,
        warnings,
      })
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      if (error instanceof EvidenceInputError) throw error
      return unavailableSearch(query, mode, recoverableNotice(error))
    } finally {
      deadline.cleanup()
    }
  }

  /**
   * Read a target chunk plus adjacent context.
   * @param {object} options - read options.
   * @param {string} options.docId - document ID.
   * @param {string} options.chunkId - target chunk ID.
   * @param {number} [options.neighborCount=1] - neighbours on each side.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<object>} bounded structured result.
   */
  async read({ docId, chunkId, neighborCount = 1, signal }) {
    const deadline = createDeadlineSignal(signal, this.readTimeoutMs, 'Knowledge read')
    try {
      throwIfAborted(signal)
      const corpus = await this.getCorpus(deadline.signal)
      return readPrepared({
        corpus,
        metadataByDocId: corpus.metadataByDocId,
        docId,
        chunkId,
        neighborCount,
        maxChars: this.maxReadChars,
      })
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      if (error instanceof EvidenceInputError) throw error
      return unavailableRead(recoverableNotice(error))
    } finally {
      deadline.cleanup()
    }
  }

  /**
   * List available source documents.
   * @param {object} options - list options.
   * @param {number} [options.limit=20] - maximum documents.
   * @param {AbortSignal} [options.signal] - caller cancellation.
   * @returns {Promise<object>} bounded structured result.
   */
  async listSources({ limit = 20, signal } = {}) {
    const deadline = createDeadlineSignal(signal, this.readTimeoutMs, 'Knowledge source list')
    try {
      throwIfAborted(signal)
      const corpus = await this.getCorpus(deadline.signal)
      return listPrepared({ corpus, limit })
    } catch (error) {
      if (signal?.aborted) throw abortReason(signal)
      if (error instanceof EvidenceInputError) throw error
      return unavailableSourceList(recoverableNotice(error))
    } finally {
      deadline.cleanup()
    }
  }

  /**
   * Load and cache the canonical chunk corpus.
   * @param {AbortSignal} signal - operation signal.
   * @returns {Promise<object>} corpus.
   */
  async getCorpus(signal) {
    if (this.corpusPromise) return this.corpusPromise
    const pending = (async () => {
      throwIfAborted(signal)
      const manifestPath = path.join(this.repoRoot, 'knowledge', 'manifest.jsonl')
      let manifestText
      try {
        manifestText = await this.readFileImpl(manifestPath, { encoding: 'utf8', signal })
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal)
        throw new EvidenceUnavailableError(
          'The knowledge manifest is unavailable. Run npm.cmd run knowledge:manifest.',
          'MANIFEST_UNAVAILABLE',
          { cause: error },
        )
      }

      const documents = parseJsonLines(manifestText, 'knowledge manifest')
      const chunks = []
      const metadataByDocId = {}
      for (const document of documents) {
        validateDocument(document)
        if (metadataByDocId[document.doc_id]) {
          throw new EvidenceUnavailableError(
            `Duplicate document ID in manifest: ${document.doc_id}`,
            'MANIFEST_INVALID',
          )
        }
        metadataByDocId[document.doc_id] = document
        const canonicalPath = safeRepoPath(this.repoRoot, document.canonical_path)
        let markdown
        try {
          markdown = await this.readFileImpl(canonicalPath, { encoding: 'utf8', signal })
        } catch (error) {
          if (signal?.aborted) throw abortReason(signal)
          throw new EvidenceUnavailableError(
            `Canonical document ${document.doc_id} is unavailable.`,
            'DOCUMENT_UNAVAILABLE',
            { cause: error },
          )
        }
        chunks.push(...chunkMarkdown(markdown, {
          docId: document.doc_id,
          title: document.title,
        }))
      }

      return { documents, chunks, metadataByDocId }
    })()

    this.corpusPromise = cacheUntilSettled(this, 'corpusPromise', pending)
    return this.corpusPromise
  }

  /**
   * Load the BM25 index or rebuild it in memory without modifying disk.
   * @param {object} corpus - current corpus.
   * @param {AbortSignal} signal - operation signal.
   * @returns {Promise<{index: object|null, warning?: string}>} BM25 state.
   */
  async getBm25Index(corpus, signal) {
    if (this.bm25Promise) return this.bm25Promise
    const pending = (async () => {
      throwIfAborted(signal)
      if (corpus.chunks.length === 0) {
        return { index: null, warning: 'The knowledge corpus is empty.' }
      }

      const indexPath = path.join(this.repoRoot, 'knowledge', 'index', 'bm25.json')
      try {
        const text = await this.readFileImpl(indexPath, { encoding: 'utf8', signal })
        const index = parseBM25Index(text)
        if (index.corpus_sha256 !== corpusFingerprint(corpus.chunks)) {
          return {
            index: buildBM25Index({
              chunks: corpus.chunks,
              metadataByDocId: corpus.metadataByDocId,
            }),
            warning: 'The BM25 index was stale; generated a current in-memory index.',
          }
        }
        return { index }
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal)
        return {
          index: buildBM25Index({
            chunks: corpus.chunks,
            metadataByDocId: corpus.metadataByDocId,
          }),
          warning: `The BM25 index was unavailable or invalid; generated it in memory. ${error.message}`,
        }
      }
    })()

    this.bm25Promise = cacheUntilSettled(this, 'bm25Promise', pending)
    return this.bm25Promise
  }

  /**
   * Load and validate dense vectors against the current canonical chunks.
   * @param {object} corpus - current corpus.
   * @param {AbortSignal} signal - operation signal.
   * @returns {Promise<object[]>} vector records.
   */
  async getVectorRecords(corpus, signal) {
    if (this.vectorPromise) return this.vectorPromise
    const pending = (async () => {
      throwIfAborted(signal)
      const indexPath = path.join(this.repoRoot, 'knowledge', 'index', 'vectors.jsonl')
      let text
      try {
        text = await this.readFileImpl(indexPath, { encoding: 'utf8', signal })
      } catch (error) {
        if (signal?.aborted) throw abortReason(signal)
        throw new EvidenceUnavailableError(
          'The vector index is unavailable. Run npm.cmd run embeddings:build.',
          'VECTOR_INDEX_UNAVAILABLE',
          { cause: error },
        )
      }

      const records = parseVectorIndex(text)
      const chunksById = new Map(corpus.chunks.map(chunk => [chunk.chunk_id, chunk]))
      if (records.length !== corpus.chunks.length) {
        throw new EvidenceUnavailableError(
          'The vector index is stale. Run npm.cmd run embeddings:build.',
          'VECTOR_INDEX_STALE',
        )
      }
      for (const record of records) {
        const chunk = chunksById.get(record.chunk_id)
        if (!chunk || record.text_sha256 !== sha256(chunk.text)) {
          throw new EvidenceUnavailableError(
            'The vector index does not match the current corpus. Run npm.cmd run embeddings:build.',
            'VECTOR_INDEX_STALE',
          )
        }
      }
      return records
    })()

    this.vectorPromise = cacheUntilSettled(this, 'vectorPromise', pending)
    return this.vectorPromise
  }

  /**
   * Create or reuse the configured embedding client.
   * @returns {object} embedding client.
   */
  getEmbeddingClient() {
    if (this.embeddingClient) return this.embeddingClient
    const apiKey = this.environment.EMBEDDING_API_KEY?.trim() || ''
    if (!apiKey) {
      throw new EvidenceUnavailableError(
        'EMBEDDING_API_KEY is not configured; dense search is unavailable.',
        'EMBEDDING_NOT_CONFIGURED',
      )
    }

    this.embeddingClient = this.embeddingClientFactory({
      baseUrl: this.environment.EMBEDDING_BASE_URL?.trim()
        || 'https://api.siliconflow.cn/v1',
      apiKey,
      model: this.environment.EMBEDDING_MODEL?.trim() || 'BAAI/bge-m3',
      dimension: positiveInteger(
        Number(this.environment.EMBEDDING_DIMENSION ?? 1024),
        'EMBEDDING_DIMENSION',
      ),
      timeoutMs: positiveInteger(
        Number(this.environment.EMBEDDING_TIMEOUT_MS ?? 30_000),
        'EMBEDDING_TIMEOUT_MS',
      ),
      maxRetries: nonNegativeInteger(
        Number(this.environment.EMBEDDING_MAX_RETRIES ?? 2),
        'EMBEDDING_MAX_RETRIES',
      ),
    })
    return this.embeddingClient
  }
}

/**
 * Parse newline-delimited JSON objects.
 * @param {string} text - JSONL source.
 * @param {string} label - diagnostic label.
 * @returns {object[]} parsed records.
 */
function parseJsonLines(text, label) {
  const lines = text.split(/\r?\n/).filter(line => line.trim() !== '')
  return lines.map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new EvidenceUnavailableError(
        `${label} contains invalid JSON on line ${index + 1}.`,
        'MANIFEST_INVALID',
        { cause: error },
      )
    }
  })
}

/**
 * Validate the manifest fields required by runtime tools.
 * @param {object} document - manifest record.
 */
function validateDocument(document) {
  if (
    !document
    || typeof document.doc_id !== 'string'
    || document.doc_id === ''
    || typeof document.title !== 'string'
    || typeof document.canonical_path !== 'string'
  ) {
    throw new EvidenceUnavailableError(
      'Knowledge manifest contains an invalid document record.',
      'MANIFEST_INVALID',
    )
  }
}

/**
 * Resolve a manifest path while preventing traversal outside the repository.
 * @param {string} repoRoot - repository root.
 * @param {string} relativePath - manifest path.
 * @returns {string} absolute path.
 */
function safeRepoPath(repoRoot, relativePath) {
  const resolved = path.resolve(repoRoot, relativePath)
  const relative = path.relative(repoRoot, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new EvidenceUnavailableError(
      `Manifest path escapes the repository: ${relativePath}`,
      'MANIFEST_INVALID',
    )
  }
  return resolved
}

/**
 * Cache a promise and clear the slot after rejection so later calls can retry.
 * @param {object} target - cache owner.
 * @param {string} property - promise property name.
 * @param {Promise<unknown>} pending - cache candidate.
 * @returns {Promise<unknown>} cached promise.
 */
function cacheUntilSettled(target, property, pending) {
  pending.catch(() => {
    if (target[property] === pending) target[property] = null
  })
  return pending
}

/**
 * Create a deadline signal that also follows caller cancellation.
 * @param {AbortSignal|undefined} signal - caller signal.
 * @param {number} timeoutMs - deadline in milliseconds.
 * @param {string} operation - diagnostic operation name.
 * @returns {{signal: AbortSignal, cleanup: Function}} deadline.
 */
function createDeadlineSignal(signal, timeoutMs, operation) {
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(abortReason(signal))
  if (signal) {
    if (signal.aborted) {
      forwardAbort()
    } else {
      signal.addEventListener('abort', forwardAbort, { once: true })
    }
  }
  const timer = setTimeout(() => {
    controller.abort(new EvidenceUnavailableError(
      `${operation} timed out after ${timeoutMs} ms.`,
      'EVIDENCE_TIMEOUT',
    ))
  }, timeoutMs)

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    },
  }
}

/**
 * Throw the caller's cancellation reason.
 * @param {AbortSignal|undefined} signal - caller signal.
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

/**
 * Return a stable abort reason.
 * @param {AbortSignal|undefined} signal - signal.
 * @returns {unknown} abort reason.
 */
function abortReason(signal) {
  return signal?.reason ?? new DOMException('Operation aborted', 'AbortError')
}

/**
 * Turn an operational failure into model-safe recovery guidance.
 * @param {unknown} error - failure.
 * @returns {string} notice.
 */
function recoverableNotice(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.startsWith('Knowledge') || message.startsWith('The ')
    ? message
    : `Knowledge retrieval is temporarily unavailable: ${message}`
}

/**
 * Validate a positive integer.
 * @param {unknown} value - candidate.
 * @param {string} name - field name.
 * @returns {number} validated value.
 */
function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Validate a non-negative integer.
 * @param {unknown} value - candidate.
 * @param {string} name - field name.
 * @returns {number} validated value.
 */
function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
  return value
}

/**
 * Validate a character budget.
 * @param {unknown} value - candidate.
 * @param {string} name - field name.
 * @returns {number} validated value.
 */
function characterBudget(value, name) {
  if (!Number.isInteger(value) || value < 200) {
    throw new RangeError(`${name} must be an integer of at least 200`)
  }
  return value
}

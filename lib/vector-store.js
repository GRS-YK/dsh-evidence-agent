/**
 * Build and serialize the generated JSONL vector index.
 * @module dsh-evidence-agent/lib/vector-store
 */

import { sha256 } from './knowledge-manifest.js'

/**
 * Build one JSONL vector record per chunk.
 * @param {object} options - record-building options.
 * @param {object[]} options.chunks - chunks from the Markdown chunker.
 * @param {number[][]} options.vectors - vectors in the same order as chunks.
 * @param {string} options.model - embedding model ID.
 * @param {number} options.dimension - expected vector dimension.
 * @param {Record<string, object>} [options.metadataByDocId] - source metadata.
 * @returns {object[]} vector records.
 */
export function buildVectorRecords({
  chunks,
  vectors,
  model,
  dimension,
  metadataByDocId = {},
}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new TypeError('chunks must be a non-empty array')
  }
  if (!Array.isArray(vectors) || vectors.length !== chunks.length) {
    throw new TypeError('vectors must match chunks one-to-one')
  }
  if (typeof model !== 'string' || model.trim() === '') {
    throw new TypeError('model must be a non-empty string')
  }
  if (!Number.isInteger(dimension) || dimension < 1) {
    throw new RangeError('dimension must be a positive integer')
  }

  const chunkIds = new Set()
  return chunks.map((chunk, index) => {
    if (!chunk || typeof chunk !== 'object') {
      throw new TypeError(`chunks[${index}] must be an object`)
    }
    if (typeof chunk.chunk_id !== 'string' || chunk.chunk_id === '') {
      throw new TypeError(`chunks[${index}].chunk_id must be a non-empty string`)
    }
    if (chunkIds.has(chunk.chunk_id)) {
      throw new Error(`duplicate chunk_id: ${chunk.chunk_id}`)
    }
    chunkIds.add(chunk.chunk_id)

    const vector = vectors[index]
    validateVector(vector, dimension, chunk.chunk_id)
    const metadata = metadataByDocId[chunk.doc_id] ?? {}

    return {
      doc_id: chunk.doc_id,
      chunk_id: chunk.chunk_id,
      document_title: chunk.document_title,
      section: chunk.section,
      heading_path: chunk.heading_path,
      section_line: chunk.section_line,
      line_start: chunk.line_start,
      line_end: chunk.line_end,
      token_count: chunk.token_count,
      char_count: chunk.char_count,
      text: chunk.text,
      text_sha256: sha256(chunk.text),
      source_url: metadata.source_url ?? null,
      canonical_path: metadata.canonical_path ?? null,
      license: metadata.license ?? null,
      embedding_model: model,
      embedding_dimension: dimension,
      embedding: vector,
    }
  })
}

/**
 * Serialize vector records as stable newline-delimited JSON.
 * @param {object[]} records - vector records.
 * @returns {string} JSONL ending with a newline.
 */
export function serializeVectorIndex(records) {
  if (!Array.isArray(records)) {
    throw new TypeError('records must be an array')
  }
  if (records.length === 0) return ''
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

/**
 * Parse and validate a JSONL vector index.
 * @param {string} text - JSONL text.
 * @returns {object[]} vector records.
 */
export function parseVectorIndex(text) {
  if (typeof text !== 'string') {
    throw new TypeError('vector index text must be a string')
  }
  if (text.trim() === '') return []

  const records = text.trimEnd().split('\n').map((line, index) => {
    let record
    try {
      record = JSON.parse(line)
    } catch (error) {
      throw new Error(`Invalid vector index JSON on line ${index + 1}`, { cause: error })
    }
    if (!record || typeof record !== 'object' || typeof record.chunk_id !== 'string') {
      throw new Error(`Invalid vector record on line ${index + 1}`)
    }
    return record
  })

  const chunkIds = new Set()
  for (const record of records) {
    if (chunkIds.has(record.chunk_id)) {
      throw new Error(`Duplicate chunk_id in vector index: ${record.chunk_id}`)
    }
    chunkIds.add(record.chunk_id)
    if (!Number.isInteger(record.embedding_dimension) || record.embedding_dimension < 1) {
      throw new Error(`Invalid embedding_dimension for ${record.chunk_id}`)
    }
    validateVector(record.embedding, record.embedding_dimension, record.chunk_id)
  }
  return records
}

/**
 * Check whether an existing vector can be reused for the current chunk.
 * @param {object} record - existing vector record.
 * @param {object} chunk - current chunk.
 * @param {string} model - expected embedding model.
 * @param {number} dimension - expected vector dimension.
 * @returns {boolean} whether the vector is reusable.
 */
export function isVectorRecordReusable(record, chunk, model, dimension) {
  if (!record || !chunk) return false
  return Boolean(
    record.chunk_id === chunk.chunk_id
    && record.text_sha256 === sha256(chunk.text)
    && record.embedding_model === model
    && record.embedding_dimension === dimension,
  )
}

/**
 * Validate a dense numeric vector.
 * @param {unknown} vector - candidate vector.
 * @param {number} dimension - expected dimension.
 * @param {string} chunkId - chunk ID for diagnostics.
 */
function validateVector(vector, dimension, chunkId) {
  if (!Array.isArray(vector) || vector.length !== dimension) {
    throw new Error(
      `Embedding for ${chunkId} must contain exactly ${dimension} numbers`,
    )
  }
  vector.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Embedding for ${chunkId} has an invalid value at position ${index}`)
    }
  })
}

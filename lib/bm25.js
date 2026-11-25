/**
 * Deterministic BM25 indexing and search for mixed Chinese and English text.
 * @module dsh-evidence-agent/lib/bm25
 */

import { sha256 } from './knowledge-manifest.js'

export const BM25_SCHEMA_VERSION = 1
export const BM25_TOKENIZER_VERSION = 'cjk-unigram-bigram-v1'

const CJK_CHAR_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u
const LEXICAL_SEGMENT_PATTERN = /(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+)|[A-Za-z0-9_]+/gu

/**
 * Tokenize text into prefixed English words and Chinese character n-grams.
 *
 * Chinese text emits both characters and adjacent bigrams. The prefixes keep
 * terms from different token classes separate and make index inspection easier.
 * @param {string} text - text to tokenize.
 * @returns {string[]} tokens in source order, including repeated terms.
 */
export function tokenize(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string')
  }

  const tokens = []
  const normalized = text.normalize('NFKC')
  for (const segment of normalized.match(LEXICAL_SEGMENT_PATTERN) ?? []) {
    if (CJK_CHAR_PATTERN.test(segment)) {
      const characters = Array.from(segment)
      for (const character of characters) {
        tokens.push(`c:${character}`)
      }
      for (let index = 0; index < characters.length - 1; index++) {
        tokens.push(`g:${characters[index]}${characters[index + 1]}`)
      }
      continue
    }

    for (const word of segment.toLowerCase().split(/_+/)) {
      if (word) tokens.push(`w:${word}`)
    }
  }
  return tokens
}

/**
 * Build a portable BM25 index from chunks.
 * @param {object} options - index-building options.
 * @param {object[]} options.chunks - chunks from the Markdown chunker.
 * @param {Record<string, object>} [options.metadataByDocId] - source metadata.
 * @param {number} [options.k1=1.5] - term-frequency saturation parameter.
 * @param {number} [options.b=0.75] - document-length normalization parameter.
 * @returns {object} serializable BM25 index.
 */
export function buildBM25Index({
  chunks,
  metadataByDocId = {},
  k1 = 1.5,
  b = 0.75,
} = {}) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new TypeError('chunks must be a non-empty array')
  }
  validateParameters(k1, b)

  const chunkIds = new Set()
  const documents = chunks.map((chunk, index) => {
    if (!chunk || typeof chunk !== 'object') {
      throw new TypeError(`chunks[${index}] must be an object`)
    }
    if (typeof chunk.chunk_id !== 'string' || chunk.chunk_id === '') {
      throw new TypeError(`chunks[${index}].chunk_id must be a non-empty string`)
    }
    if (chunkIds.has(chunk.chunk_id)) {
      throw new Error(`duplicate chunk_id: ${chunk.chunk_id}`)
    }
    if (typeof chunk.text !== 'string' || chunk.text.trim() === '') {
      throw new TypeError(`chunks[${index}].text must be non-empty text`)
    }
    chunkIds.add(chunk.chunk_id)

    const tokens = tokenize(chunk.text)
    if (tokens.length === 0) {
      throw new Error(`chunk ${chunk.chunk_id} produced no searchable tokens`)
    }

    const frequencies = new Map()
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1)
    }
    const termFrequencies = Object.fromEntries(
      Array.from(frequencies.entries()).sort(([left], [right]) => compareStrings(left, right)),
    )
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
      text: chunk.text,
      text_sha256: sha256(chunk.text),
      source_url: metadata.source_url ?? null,
      canonical_path: metadata.canonical_path ?? null,
      license: metadata.license ?? null,
      length: tokens.length,
      term_frequencies: termFrequencies,
    }
  })

  const documentFrequencies = new Map()
  for (const document of documents) {
    for (const term of Object.keys(document.term_frequencies)) {
      documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1)
    }
  }
  const sortedDocumentFrequencies = Object.fromEntries(
    Array.from(documentFrequencies.entries())
      .sort(([left], [right]) => compareStrings(left, right)),
  )
  const totalLength = documents.reduce((sum, document) => sum + document.length, 0)

  return {
    schema_version: BM25_SCHEMA_VERSION,
    tokenizer: BM25_TOKENIZER_VERSION,
    parameters: { k1, b },
    chunk_count: documents.length,
    average_document_length: totalLength / documents.length,
    corpus_sha256: corpusFingerprint(chunks),
    document_frequencies: sortedDocumentFrequencies,
    documents,
  }
}

/**
 * Search a BM25 index.
 * @param {object} index - parsed BM25 index.
 * @param {string} query - user query.
 * @param {object} [options] - search options.
 * @param {number} [options.topK=5] - maximum number of results.
 * @returns {object[]} ranked chunks with scores and source metadata.
 */
export function searchBM25(index, query, { topK = 5 } = {}) {
  if (!index || typeof index !== 'object' || !Array.isArray(index.documents)) {
    throw new TypeError('index must be a BM25 index')
  }
  if (typeof query !== 'string') {
    throw new TypeError('query must be a string')
  }
  if (!Number.isInteger(topK) || topK < 1) {
    throw new RangeError('topK must be a positive integer')
  }

  const queryTerms = Array.from(new Set(tokenize(query)))
  if (queryTerms.length === 0) return []

  const { k1, b } = index.parameters
  const totalDocuments = index.documents.length
  const averageLength = index.average_document_length
  const scored = []

  for (const document of index.documents) {
    let score = 0
    const matchedTerms = []
    for (const term of queryTerms) {
      const termFrequency = document.term_frequencies[term] ?? 0
      if (termFrequency === 0) continue

      const documentFrequency = index.document_frequencies[term] ?? 0
      const inverseDocumentFrequency = Math.log(
        1 + (totalDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5),
      )
      const lengthNormalization = 1 - b + b * document.length / averageLength
      score += inverseDocumentFrequency
        * termFrequency * (k1 + 1)
        / (termFrequency + k1 * lengthNormalization)
      matchedTerms.push(displayTerm(term))
    }

    if (score > 0) {
      scored.push({
        score,
        matched_terms: matchedTerms,
        document,
      })
    }
  }

  scored.sort((left, right) => (
    right.score - left.score
    || compareStrings(left.document.chunk_id, right.document.chunk_id)
  ))

  return scored.slice(0, topK).map(hit => {
    const { document } = hit
    return {
      score: hit.score,
      matched_terms: hit.matched_terms,
      doc_id: document.doc_id,
      chunk_id: document.chunk_id,
      document_title: document.document_title,
      section: document.section,
      heading_path: document.heading_path,
      section_line: document.section_line,
      line_start: document.line_start,
      line_end: document.line_end,
      text: document.text,
      source_url: document.source_url,
      canonical_path: document.canonical_path,
      license: document.license,
    }
  })
}

/**
 * Serialize a BM25 index as stable, indented JSON.
 * @param {object} index - BM25 index.
 * @returns {string} JSON ending with a newline.
 */
export function serializeBM25Index(index) {
  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new TypeError('index must be an object')
  }
  return `${JSON.stringify(index, null, 2)}\n`
}

/**
 * Parse and validate a BM25 JSON index.
 * @param {string} text - serialized index.
 * @returns {object} validated BM25 index.
 */
export function parseBM25Index(text) {
  if (typeof text !== 'string') {
    throw new TypeError('BM25 index text must be a string')
  }

  let index
  try {
    index = JSON.parse(text)
  } catch (error) {
    throw new Error('Invalid BM25 index JSON', { cause: error })
  }

  if (!index || typeof index !== 'object' || Array.isArray(index)) {
    throw new Error('BM25 index root must be an object')
  }
  if (index.schema_version !== BM25_SCHEMA_VERSION) {
    throw new Error(`Unsupported BM25 schema version: ${index.schema_version}`)
  }
  if (index.tokenizer !== BM25_TOKENIZER_VERSION) {
    throw new Error(`Unsupported BM25 tokenizer: ${index.tokenizer}`)
  }
  if (!index.parameters || typeof index.parameters !== 'object') {
    throw new Error('BM25 index parameters are missing')
  }
  validateParameters(index.parameters.k1, index.parameters.b)
  if (!Array.isArray(index.documents) || index.documents.length === 0) {
    throw new Error('BM25 index must contain at least one document')
  }
  if (index.chunk_count !== index.documents.length) {
    throw new Error('BM25 chunk_count does not match documents')
  }
  if (!Number.isFinite(index.average_document_length) || index.average_document_length <= 0) {
    throw new Error('BM25 average_document_length is invalid')
  }
  if (typeof index.corpus_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(index.corpus_sha256)) {
    throw new Error('BM25 corpus_sha256 is invalid')
  }
  if (!index.document_frequencies || typeof index.document_frequencies !== 'object') {
    throw new Error('BM25 document_frequencies are missing')
  }

  const chunkIds = new Set()
  const calculatedDocumentFrequencies = new Map()
  let totalLength = 0
  for (const [documentIndex, document] of index.documents.entries()) {
    if (!document || typeof document !== 'object') {
      throw new Error(`BM25 document ${documentIndex + 1} must be an object`)
    }
    if (typeof document.chunk_id !== 'string' || document.chunk_id === '') {
      throw new Error(`BM25 document ${documentIndex + 1} has no chunk_id`)
    }
    if (chunkIds.has(document.chunk_id)) {
      throw new Error(`Duplicate chunk_id in BM25 index: ${document.chunk_id}`)
    }
    chunkIds.add(document.chunk_id)
    if (!Number.isInteger(document.length) || document.length < 1) {
      throw new Error(`Invalid token length for ${document.chunk_id}`)
    }
    if (!document.term_frequencies || typeof document.term_frequencies !== 'object') {
      throw new Error(`Missing term_frequencies for ${document.chunk_id}`)
    }

    let calculatedLength = 0
    for (const [term, frequency] of Object.entries(document.term_frequencies)) {
      if (!Number.isInteger(frequency) || frequency < 1) {
        throw new Error(`Invalid term frequency for ${term} in ${document.chunk_id}`)
      }
      calculatedLength += frequency
      calculatedDocumentFrequencies.set(
        term,
        (calculatedDocumentFrequencies.get(term) ?? 0) + 1,
      )
    }
    if (calculatedLength !== document.length) {
      throw new Error(`Token length mismatch for ${document.chunk_id}`)
    }
    totalLength += calculatedLength
  }

  const calculatedAverageLength = totalLength / index.documents.length
  if (Math.abs(calculatedAverageLength - index.average_document_length) > 1e-12) {
    throw new Error('BM25 average_document_length does not match documents')
  }
  if (Object.keys(index.document_frequencies).length !== calculatedDocumentFrequencies.size) {
    throw new Error('BM25 document_frequencies do not match documents')
  }
  for (const [term, frequency] of calculatedDocumentFrequencies) {
    if (index.document_frequencies[term] !== frequency) {
      throw new Error(`BM25 document frequency mismatch for ${term}`)
    }
  }
  return index
}

/**
 * Compute a stable fingerprint over current chunk IDs and text.
 * @param {object[]} chunks - source chunks.
 * @returns {string} SHA-256 digest.
 */
export function corpusFingerprint(chunks) {
  const fingerprintText = chunks.map(chunk => (
    `${chunk.chunk_id}\u0000${sha256(chunk.text)}`
  )).join('\n')
  return sha256(fingerprintText)
}

/**
 * Validate BM25 parameters.
 * @param {number} k1 - positive saturation parameter.
 * @param {number} b - length-normalization parameter in [0, 1].
 */
function validateParameters(k1, b) {
  if (typeof k1 !== 'number' || !Number.isFinite(k1) || k1 <= 0) {
    throw new RangeError('k1 must be a positive finite number')
  }
  if (typeof b !== 'number' || !Number.isFinite(b) || b < 0 || b > 1) {
    throw new RangeError('b must be a finite number from 0 to 1')
  }
}

/**
 * Remove internal token prefixes for result display.
 * @param {string} token - internal token.
 * @returns {string} readable term.
 */
function displayTerm(token) {
  return token.slice(2)
}

/**
 * Compare strings by Unicode code point without locale-dependent ordering.
 * @param {string} left - first string.
 * @param {string} right - second string.
 * @returns {number} sort order.
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

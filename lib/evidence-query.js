/**
 * Bounded, structured evidence results independent of filesystem and DSH.
 * @module dsh-evidence-agent/lib/evidence-query
 */

import { searchBM25 } from './bm25.js'
import { EvidenceInputError } from './evidence-errors.js'
import { hybridSearch, searchDense } from './retrieval.js'

export const SEARCH_MODES = Object.freeze(['hybrid', 'dense', 'lexical'])
export const DEFAULT_SEARCH_CHARACTERS = 12_000
export const DEFAULT_READ_CHARACTERS = 12_000

/**
 * Search an already loaded corpus without performing I/O.
 * @param {object} options - prepared search options.
 * @param {string} options.query - user query.
 * @param {string} [options.mode='hybrid'] - hybrid, dense, or lexical.
 * @param {number} [options.topK=5] - maximum final hits.
 * @param {object|null} [options.bm25Index] - parsed or generated BM25 index.
 * @param {object[]|null} [options.vectorRecords] - parsed dense records.
 * @param {number[]|null} [options.queryEmbedding] - embedded query.
 * @param {number} [options.maxChars] - total hit text character budget.
 * @param {string[]} [options.warnings] - recoverable diagnostics.
 * @returns {object} schema-safe search result.
 */
export function searchPrepared({
  query,
  mode = 'hybrid',
  topK = 5,
  bm25Index = null,
  vectorRecords = null,
  queryEmbedding = null,
  maxChars = DEFAULT_SEARCH_CHARACTERS,
  warnings = [],
}) {
  validateQuery(query)
  validateTopK(topK)
  validateCharacterBudget(maxChars)
  if (!SEARCH_MODES.includes(mode)) {
    throw new EvidenceInputError(`mode must be one of: ${SEARCH_MODES.join(', ')}`)
  }

  const notices = [...warnings]
  let actualMode = mode
  let rawHits

  if (mode === 'lexical') {
    if (!bm25Index) {
      return unavailableSearch(query, mode, 'The lexical index is unavailable.')
    }
    rawHits = searchBM25(bm25Index, query, { topK })
  } else if (mode === 'dense') {
    if (!vectorRecords || !queryEmbedding) {
      return unavailableSearch(query, mode, 'Dense retrieval is unavailable.')
    }
    rawHits = searchDense(vectorRecords, queryEmbedding, { topK })
  } else if (vectorRecords && queryEmbedding && bm25Index) {
    rawHits = hybridSearch({
      bm25Index,
      vectorRecords,
      query,
      queryEmbedding,
      candidateK: Math.max(20, topK * 4),
      topK,
    }).results
  } else if (bm25Index) {
    actualMode = 'lexical'
    rawHits = searchBM25(bm25Index, query, { topK })
    notices.push('Hybrid search degraded to BM25 because dense retrieval was unavailable.')
  } else if (vectorRecords && queryEmbedding) {
    actualMode = 'dense'
    rawHits = searchDense(vectorRecords, queryEmbedding, { topK })
    notices.push('Hybrid search degraded to dense retrieval because the lexical index was unavailable.')
  } else {
    return unavailableSearch(query, mode, 'No search index is currently available.')
  }

  const bounded = capSearchHits(rawHits, maxChars, actualMode)
  if (bounded.truncated) {
    notices.push('Search text reached its character budget; use kb_read for wider context.')
  }

  return {
    query,
    mode: actualMode,
    status: bounded.hits.length > 0 ? (actualMode === mode ? 'ok' : 'degraded') : 'empty',
    hits: bounded.hits,
    truncated: bounded.truncated,
    ...notices.length > 0 ? { notice: notices.join(' ') } : {},
  }
}

/**
 * Read a target chunk plus neighbouring chunks in source order.
 * @param {object} options - prepared read options.
 * @param {{documents: object[], chunks: object[]}} options.corpus - source corpus.
 * @param {string} options.docId - document ID.
 * @param {string} options.chunkId - target chunk ID.
 * @param {number} [options.neighborCount=1] - neighbours on each side.
 * @param {number} [options.maxChars] - total selected text budget.
 * @param {object} [options.metadataByDocId] - document metadata.
 * @returns {object} schema-safe read result.
 */
export function readPrepared({
  corpus,
  metadataByDocId = {},
  docId,
  chunkId,
  neighborCount = 1,
  maxChars = DEFAULT_READ_CHARACTERS,
}) {
  validateReadIdentifier(docId, 'doc_id')
  validateReadIdentifier(chunkId, 'chunk_id')
  if (!Number.isInteger(neighborCount) || neighborCount < 0 || neighborCount > 10) {
    throw new EvidenceInputError('neighbor_count must be an integer from 0 to 10')
  }
  validateCharacterBudget(maxChars)

  const documentChunks = corpus.chunks.filter(chunk => chunk.doc_id === docId)
  const centerIndex = documentChunks.findIndex(chunk => chunk.chunk_id === chunkId)
  if (documentChunks.length === 0 || centerIndex < 0) {
    return {
      status: 'not_found',
      selected_chunks: [],
      truncated: false,
      notice: `Chunk ${chunkId} was not found in document ${docId}.`,
    }
  }

  const initialStart = Math.max(0, centerIndex - neighborCount)
  const initialEnd = Math.min(documentChunks.length - 1, centerIndex + neighborCount)
  let start = initialStart
  let end = initialEnd
  let selected = documentChunks.slice(start, end + 1)

  while (start < centerIndex && chunksCharacters(selected) > maxChars) {
    start++
    selected = documentChunks.slice(start, end + 1)
  }
  while (end > centerIndex && chunksCharacters(selected) > maxChars) {
    end--
    selected = documentChunks.slice(start, end + 1)
  }

  let centerTruncated = false
  if (chunksCharacters(selected) > maxChars) {
    start = centerIndex
    end = centerIndex
    selected = [documentChunks[centerIndex]]
    centerTruncated = true
  }

  const selectedChunks = selected.map(chunk => {
    const text = centerTruncated
      ? truncateText(chunk.text, maxChars)
      : chunk.text
    return {
      chunk_id: chunk.chunk_id,
      section: chunk.section,
      heading_path: chunk.heading_path,
      line_start: chunk.line_start,
      line_end: chunk.line_end,
      text,
    }
  })
  const truncated = start > initialStart
    || end < initialEnd
    || centerTruncated
    || selectedChunks.some((chunk, index) => chunk.text !== selected[index].text)
  const nextChunkId = end < documentChunks.length - 1
    ? documentChunks[end + 1].chunk_id
    : undefined
  const metadata = metadataByDocId[docId] ?? {}
  const document = {
    doc_id: docId,
    title: metadata.title ?? documentChunks[0].document_title ?? docId,
    source_type: metadata.source_format ?? 'Markdown',
    page_count: metadata.page_count ?? null,
    chunk_count: documentChunks.length,
    ...metadata.source_url ? { source_url: metadata.source_url } : {},
    ...metadata.license ? { license: metadata.license } : {},
    ...metadata.retrieval_date ? { updated_at: metadata.retrieval_date } : {},
  }

  return {
    status: truncated ? 'truncated' : 'ok',
    document,
    selected_chunks: selectedChunks,
    truncated,
    ...nextChunkId ? { next_chunk_id: nextChunkId } : {},
    ...truncated
      ? { notice: 'The read window reached its character budget; continue with next_chunk_id when available.' }
      : {},
  }
}

/**
 * List documents available in the knowledge corpus.
 * @param {object} options - prepared list options.
 * @param {{documents: object[], chunks: object[]}} options.corpus - source corpus.
 * @param {number} [options.limit=20] - maximum documents.
 * @returns {object} schema-safe source list.
 */
export function listPrepared({ corpus, limit = 20 }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new EvidenceInputError('limit must be an integer from 1 to 100')
  }

  const documents = corpus.documents.slice(0, limit).map(document => ({
    doc_id: document.doc_id,
    title: document.title,
    source_type: document.source_format ?? 'Markdown',
    page_count: document.page_count ?? null,
    chunk_count: corpus.chunks.filter(chunk => chunk.doc_id === document.doc_id).length,
    updated_at: document.retrieval_date ?? '',
    ...document.source_url ? { source_url: document.source_url } : {},
    ...document.license ? { license: document.license } : {},
  }))

  return {
    status: documents.length === 0 ? 'empty' : 'ok',
    total: corpus.documents.length,
    documents,
    truncated: corpus.documents.length > documents.length,
    ...corpus.documents.length === 0
      ? { notice: 'The knowledge corpus is empty.' }
      : {},
  }
}

/**
 * Build a search result for an unavailable retrieval mode.
 * @param {string} query - original query.
 * @param {string} mode - requested mode.
 * @param {string} notice - recovery guidance.
 * @returns {object} search result.
 */
export function unavailableSearch(query, mode, notice) {
  return {
    query,
    mode,
    status: 'unavailable',
    hits: [],
    truncated: false,
    notice,
  }
}

/**
 * Build a read result for an unavailable corpus.
 * @param {string} notice - recovery guidance.
 * @returns {object} read result.
 */
export function unavailableRead(notice) {
  return {
    status: 'unavailable',
    selected_chunks: [],
    truncated: false,
    notice,
  }
}

/**
 * Build a source-list result for an unavailable corpus.
 * @param {string} notice - recovery guidance.
 * @returns {object} source-list result.
 */
export function unavailableSourceList(notice) {
  return {
    status: 'unavailable',
    total: 0,
    documents: [],
    truncated: false,
    notice,
  }
}

/**
 * Apply the aggregate text budget to ranked hits.
 * @param {object[]} rawHits - ranked retrieval hits.
 * @param {number} maxChars - total character budget.
 * @param {string} mode - actual retrieval mode.
 * @returns {{hits: object[], truncated: boolean}} bounded hits.
 */
function capSearchHits(rawHits, maxChars, mode) {
  const hits = []
  let remaining = maxChars
  let truncated = false

  for (const hit of rawHits) {
    if (remaining <= 0) {
      truncated = true
      break
    }
    const fullText = hit.text ?? ''
    const text = truncateText(fullText, remaining)
    const textTruncated = text !== fullText
    const score = mode === 'hybrid' ? hit.rrf_score : hit.score
    hits.push({
      doc_id: hit.doc_id,
      chunk_id: hit.chunk_id,
      title: hit.document_title,
      ...Number.isInteger(hit.page) ? { page: hit.page } : {},
      line_start: hit.line_start,
      line_end: hit.line_end,
      score,
      score_kind: mode === 'hybrid' ? 'rrf' : mode === 'dense' ? 'cosine' : 'bm25',
      text,
      ...hit.source_url ? { source_url: hit.source_url } : {},
      ...hit.section ? { section: hit.section } : {},
    })
    remaining -= characterLength(text)
    if (textTruncated) {
      truncated = true
      break
    }
  }

  return { hits, truncated }
}

/**
 * Count Unicode code points rather than UTF-16 code units.
 * @param {string} text - input text.
 * @returns {number} character count.
 */
export function characterLength(text) {
  return Array.from(text).length
}

/**
 * Truncate text by Unicode code points.
 * @param {string} text - input text.
 * @param {number} maximum - maximum characters.
 * @returns {string} original or truncated text.
 */
export function truncateText(text, maximum) {
  const characters = Array.from(text)
  if (characters.length <= maximum) return text
  return characters.slice(0, maximum).join('')
}

/**
 * Count text plus separators for a contiguous chunk window.
 * @param {object[]} chunks - selected chunks.
 * @returns {number} character count.
 */
function chunksCharacters(chunks) {
  return chunks.reduce((total, chunk, index) => (
    total + characterLength(chunk.text) + (index === 0 ? 0 : 2)
  ), 0)
}

/**
 * Validate a search query.
 * @param {unknown} query - candidate query.
 */
function validateQuery(query) {
  if (typeof query !== 'string' || query.trim() === '') {
    throw new EvidenceInputError('query must be a non-empty string')
  }
  if (characterLength(query) > 2_000) {
    throw new EvidenceInputError('query must not exceed 2000 characters')
  }
}

/**
 * Validate a final result count.
 * @param {unknown} topK - candidate count.
 */
function validateTopK(topK) {
  if (!Number.isInteger(topK) || topK < 1 || topK > 10) {
    throw new EvidenceInputError('top_k must be an integer from 1 to 10')
  }
}

/**
 * Validate a character budget.
 * @param {unknown} maxChars - candidate character budget.
 */
function validateCharacterBudget(maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < 200) {
    throw new EvidenceInputError('character budget must be an integer of at least 200')
  }
}

/**
 * Validate a document or chunk ID.
 * @param {unknown} value - candidate identifier.
 * @param {string} name - field name.
 */
function validateReadIdentifier(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new EvidenceInputError(`${name} must be a non-empty string`)
  }
}

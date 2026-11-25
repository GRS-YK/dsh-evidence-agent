/**
 * Dense retrieval and reciprocal-rank fusion for evidence search.
 * @module dsh-evidence-agent/lib/retrieval
 */

import { searchBM25 } from './bm25.js'

const RESULT_FIELDS = [
  'doc_id',
  'chunk_id',
  'document_title',
  'section',
  'heading_path',
  'section_line',
  'line_start',
  'line_end',
  'text',
  'source_url',
  'canonical_path',
  'license',
]

/**
 * Compute cosine similarity between two dense vectors.
 * @param {number[]} left - first vector.
 * @param {number[]} right - second vector.
 * @returns {number} cosine similarity.
 */
export function cosineSimilarity(left, right) {
  validateVector(left, 'left vector')
  validateVector(right, 'right vector')
  if (left.length !== right.length) {
    throw new RangeError('vectors must have the same dimension')
  }

  let dotProduct = 0
  let leftNormSquared = 0
  let rightNormSquared = 0
  for (let index = 0; index < left.length; index++) {
    dotProduct += left[index] * right[index]
    leftNormSquared += left[index] * left[index]
    rightNormSquared += right[index] * right[index]
  }
  if (leftNormSquared === 0 || rightNormSquared === 0) {
    throw new RangeError('vectors must not have zero magnitude')
  }
  return dotProduct / Math.sqrt(leftNormSquared * rightNormSquared)
}

/**
 * Rank vector records by cosine similarity.
 * @param {object[]} records - records from the vector index.
 * @param {number[]} queryVector - embedded query.
 * @param {object} [options] - search options.
 * @param {number} [options.topK=20] - maximum number of candidates.
 * @returns {object[]} ranked vector records.
 */
export function searchDense(records, queryVector, { topK = 20 } = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError('vector records must be an array')
  }
  validateVector(queryVector, 'query vector')
  validateTopK(topK)
  if (records.length === 0) return []

  const scored = records.map((record, index) => {
    if (!record || typeof record !== 'object') {
      throw new TypeError(`vector record ${index + 1} must be an object`)
    }
    if (typeof record.chunk_id !== 'string' || record.chunk_id === '') {
      throw new Error(`vector record ${index + 1} has no chunk_id`)
    }
    return {
      score: cosineSimilarity(queryVector, record.embedding),
      record,
    }
  })

  scored.sort((left, right) => (
    right.score - left.score
    || compareStrings(left.record.chunk_id, right.record.chunk_id)
  ))

  return scored.slice(0, topK).map(({ score, record }) => ({
    score,
    ...pickResultFields(record),
  }))
}

/**
 * Fuse multiple ranked lists using reciprocal-rank fusion.
 * @param {object[]} rankedLists - lists with source, results, and optional weight.
 * @param {object} [options] - fusion options.
 * @param {number} [options.rankConstant=60] - RRF smoothing constant.
 * @param {number} [options.topK=10] - maximum number of fused results.
 * @returns {object[]} fused results with component ranks and scores.
 */
export function rrfFuse(rankedLists, { rankConstant = 60, topK = 10 } = {}) {
  if (!Array.isArray(rankedLists) || rankedLists.length === 0) {
    throw new TypeError('rankedLists must be a non-empty array')
  }
  if (
    typeof rankConstant !== 'number'
    || !Number.isFinite(rankConstant)
    || rankConstant <= 0
  ) {
    throw new RangeError('rankConstant must be a positive finite number')
  }
  validateTopK(topK)

  const sources = new Set()
  const fused = new Map()
  for (const [listIndex, rankedList] of rankedLists.entries()) {
    if (!rankedList || typeof rankedList !== 'object') {
      throw new TypeError(`rankedLists[${listIndex}] must be an object`)
    }
    const source = rankedList.source
    if (typeof source !== 'string' || source.trim() === '') {
      throw new TypeError(`rankedLists[${listIndex}].source must be a non-empty string`)
    }
    if (sources.has(source)) {
      throw new Error(`duplicate ranked-list source: ${source}`)
    }
    sources.add(source)

    const weight = rankedList.weight ?? 1
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      throw new RangeError(`weight for ${source} must be a non-negative finite number`)
    }
    if (!Array.isArray(rankedList.results)) {
      throw new TypeError(`results for ${source} must be an array`)
    }

    const seenChunkIds = new Set()
    rankedList.results.forEach((result, resultIndex) => {
      if (!result || typeof result !== 'object') {
        throw new TypeError(`${source} result ${resultIndex + 1} must be an object`)
      }
      if (typeof result.chunk_id !== 'string' || result.chunk_id === '') {
        throw new Error(`${source} result ${resultIndex + 1} has no chunk_id`)
      }
      if (seenChunkIds.has(result.chunk_id)) {
        throw new Error(`duplicate ${source} result: ${result.chunk_id}`)
      }
      seenChunkIds.add(result.chunk_id)

      const rank = resultIndex + 1
      let candidate = fused.get(result.chunk_id)
      if (!candidate) {
        candidate = {
          ...pickResultFields(result),
          rrf_score: 0,
          ranks: {},
          scores: {},
          matchedTerms: new Set(),
        }
        fused.set(result.chunk_id, candidate)
      } else {
        fillMissingFields(candidate, result)
      }

      candidate.rrf_score += weight / (rankConstant + rank)
      candidate.ranks[source] = rank
      if (typeof result.score === 'number' && Number.isFinite(result.score)) {
        candidate.scores[source] = result.score
      }
      if (Array.isArray(result.matched_terms)) {
        for (const term of result.matched_terms) candidate.matchedTerms.add(term)
      }
    })
  }

  return Array.from(fused.values())
    .sort((left, right) => (
      right.rrf_score - left.rrf_score
      || compareStrings(left.chunk_id, right.chunk_id)
    ))
    .slice(0, topK)
    .map(candidate => {
      const { matchedTerms, ...result } = candidate
      return {
        ...result,
        matched_terms: Array.from(matchedTerms),
      }
    })
}

/**
 * Run lexical and dense retrieval, then fuse their ranked candidates with RRF.
 * @param {object} options - hybrid search options.
 * @param {object} options.bm25Index - parsed BM25 index.
 * @param {object[]} options.vectorRecords - parsed dense vector records.
 * @param {string} options.query - original user query.
 * @param {number[]} options.queryEmbedding - embedded query.
 * @param {number} [options.candidateK=20] - candidates from each retriever.
 * @param {number} [options.topK=5] - final result count.
 * @param {number} [options.rankConstant=60] - RRF smoothing constant.
 * @param {number} [options.denseWeight=1] - dense-list RRF weight.
 * @param {number} [options.lexicalWeight=1] - BM25-list RRF weight.
 * @returns {object} fused results and candidate diagnostics.
 */
export function hybridSearch({
  bm25Index,
  vectorRecords,
  query,
  queryEmbedding,
  candidateK = 20,
  topK = 5,
  rankConstant = 60,
  denseWeight = 1,
  lexicalWeight = 1,
}) {
  if (typeof query !== 'string') {
    throw new TypeError('query must be a string')
  }
  validateTopK(candidateK)
  validateTopK(topK)

  const denseResults = searchDense(vectorRecords, queryEmbedding, { topK: candidateK })
  const lexicalResults = searchBM25(bm25Index, query, { topK: candidateK })
  const results = rrfFuse([
    {
      source: 'dense',
      results: denseResults,
      weight: denseWeight,
    },
    {
      source: 'lexical',
      results: lexicalResults,
      weight: lexicalWeight,
    },
  ], {
    rankConstant,
    topK,
  })

  return {
    results,
    diagnostics: {
      dense_candidates: denseResults.length,
      lexical_candidates: lexicalResults.length,
      rank_constant: rankConstant,
      dense_weight: denseWeight,
      lexical_weight: lexicalWeight,
    },
  }
}

/**
 * Validate a dense vector.
 * @param {unknown} vector - candidate vector.
 * @param {string} label - diagnostic label.
 */
function validateVector(vector, label) {
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`)
  }
  vector.forEach((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new TypeError(`${label} has an invalid value at position ${index}`)
    }
  })
}

/**
 * Validate a result limit.
 * @param {number} topK - candidate limit.
 */
function validateTopK(topK) {
  if (!Number.isInteger(topK) || topK < 1) {
    throw new RangeError('topK must be a positive integer')
  }
}

/**
 * Select stable public result fields.
 * @param {object} result - source result.
 * @returns {object} selected fields.
 */
function pickResultFields(result) {
  return Object.fromEntries(
    RESULT_FIELDS
      .filter(field => result[field] !== undefined)
      .map(field => [field, result[field]]),
  )
}

/**
 * Fill metadata fields missing from an already-seen chunk.
 * @param {object} target - fused candidate.
 * @param {object} source - additional result metadata.
 */
function fillMissingFields(target, source) {
  for (const field of RESULT_FIELDS) {
    if (target[field] === undefined && source[field] !== undefined) {
      target[field] = source[field]
    }
  }
}

/**
 * Compare strings by Unicode code point.
 * @param {string} left - first string.
 * @param {string} right - second string.
 * @returns {number} sort order.
 */
function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

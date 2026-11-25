#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBM25Index } from '../lib/bm25.js'
import { createOpenAICompatibleEmbeddingClient } from '../lib/embedding-client.js'
import { loadLocalEnv } from '../lib/local-env.js'
import { hybridSearch } from '../lib/retrieval.js'
import { parseVectorIndex } from '../lib/vector-store.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const envPath = path.join(repoRoot, '.env')
const vectorIndexPath = path.join(repoRoot, 'knowledge', 'index', 'vectors.jsonl')
const bm25IndexPath = path.join(repoRoot, 'knowledge', 'index', 'bm25.json')
const args = process.argv.slice(2)
let settings = { query: '', topK: 5, candidateK: 20 }

try {
  settings = parseArguments(args)
} catch (error) {
  console.error(`Invalid hybrid search arguments: ${error.message}`)
  console.error(
    'Usage: npm.cmd run hybrid:search -- "query" [--top-k 5] [--candidate-k 20]',
  )
  process.exitCode = 2
}

if (!settings.query && process.exitCode === undefined) {
  console.error(
    'Usage: npm.cmd run hybrid:search -- "query" [--top-k 5] [--candidate-k 20]',
  )
  process.exitCode = 2
} else if (settings.query) {
  run().catch(error => {
    console.error(`Hybrid search failed: ${error.message}`)
    process.exitCode = 1
  })
}

async function run() {
  loadLocalEnv(envPath)
  const config = readEmbeddingConfig()
  if (!config.apiKey) {
    throw new Error(
      'EMBEDDING_API_KEY is missing. Run scripts/set-embedding-key.ps1 first.',
    )
  }

  const [vectorText, bm25Text] = await Promise.all([
    readFile(vectorIndexPath, 'utf8').catch(error => {
      throw indexReadError(error, 'vector', 'npm.cmd run embeddings:build')
    }),
    readFile(bm25IndexPath, 'utf8').catch(error => {
      throw indexReadError(error, 'BM25', 'npm.cmd run bm25:build')
    }),
  ])
  const vectorRecords = parseVectorIndex(vectorText)
  const bm25Index = parseBM25Index(bm25Text)
  const embeddingClient = createOpenAICompatibleEmbeddingClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    dimension: config.dimension,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
  })

  const [queryEmbedding] = await embeddingClient.embed([settings.query])
  const { results, diagnostics } = hybridSearch({
    bm25Index,
    vectorRecords,
    query: settings.query,
    queryEmbedding,
    candidateK: settings.candidateK,
    topK: settings.topK,
  })

  console.log(`Query: ${settings.query}`)
  console.log(
    `Candidates: dense=${diagnostics.dense_candidates}, `
    + `lexical=${diagnostics.lexical_candidates}, RRF k=${diagnostics.rank_constant}`,
  )
  if (results.length === 0) {
    console.log('No matches.')
    return
  }

  for (const [indexPosition, result] of results.entries()) {
    console.log(
      `\n${indexPosition + 1}. rrf=${result.rrf_score.toFixed(6)} `
      + `${result.chunk_id} lines=${result.line_start}-${result.line_end}`,
    )
    console.log(
      `   ${result.document_title} > ${result.heading_path.join(' > ') || result.section}`,
    )
    console.log(`   ${formatRank('dense', result)}; ${formatRank('lexical', result)}`)
    if (result.matched_terms.length > 0) {
      console.log(`   lexical terms: ${result.matched_terms.join(', ')}`)
    }
    console.log(`   ${makeSnippet(result.text)}`)
    if (result.source_url) console.log(`   source: ${result.source_url}`)
  }
}

/**
 * Parse command-line arguments.
 * @param {string[]} values - arguments after the script name.
 * @returns {{query: string, topK: number, candidateK: number}} settings.
 */
function parseArguments(values) {
  const queryParts = []
  let topK = 5
  let candidateK = 20

  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (value === '--') continue
    if (value === '--top-k') {
      topK = parsePositiveInteger(values[++index], '--top-k')
      continue
    }
    if (value === '--candidate-k') {
      candidateK = parsePositiveInteger(values[++index], '--candidate-k')
      continue
    }
    queryParts.push(value)
  }

  return { query: queryParts.join(' ').trim(), topK, candidateK }
}

/**
 * Read embedding settings from existing environment variables.
 * @returns {object} normalized configuration.
 */
function readEmbeddingConfig() {
  return {
    baseUrl: process.env.EMBEDDING_BASE_URL?.trim() || 'https://api.siliconflow.cn/v1',
    apiKey: process.env.EMBEDDING_API_KEY?.trim() || '',
    model: process.env.EMBEDDING_MODEL?.trim() || 'BAAI/bge-m3',
    dimension: positiveInteger('EMBEDDING_DIMENSION', 1024),
    timeoutMs: positiveInteger('EMBEDDING_TIMEOUT_MS', 30_000),
    maxRetries: nonNegativeInteger('EMBEDDING_MAX_RETRIES', 2),
  }
}

/**
 * Convert a file-read failure into an actionable command-line message.
 * @param {NodeJS.ErrnoException} error - read error.
 * @param {string} label - index display name.
 * @param {string} buildCommand - command that repairs the index.
 * @returns {Error} actionable error.
 */
function indexReadError(error, label, buildCommand) {
  if (error.code === 'ENOENT') {
    return new Error(`${label} index is missing; run ${buildCommand}`)
  }
  return error
}

/**
 * Format one retriever's rank and score.
 * @param {string} source - retriever source.
 * @param {object} result - fused result.
 * @returns {string} compact diagnostic.
 */
function formatRank(source, result) {
  const rank = result.ranks[source]
  if (rank === undefined) return `${source}=miss`
  const score = result.scores[source]
  return `${source}=#${rank} score=${score.toFixed(4)}`
}

/**
 * Create a compact single-line result preview.
 * @param {string} text - full chunk text.
 * @param {number} [maximumLength=220] - maximum preview length.
 * @returns {string} preview.
 */
function makeSnippet(text, maximumLength = 220) {
  const compact = text.replace(/\s+/g, ' ').trim()
  return compact.length <= maximumLength
    ? compact
    : `${compact.slice(0, maximumLength - 1)}…`
}

/**
 * Parse a positive integer argument.
 * @param {string|undefined} raw - raw command-line value.
 * @param {string} name - option name.
 * @returns {number} parsed integer.
 */
function parsePositiveInteger(raw, name) {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Read a positive integer environment value.
 * @param {string} name - variable name.
 * @param {number} fallback - default value.
 * @returns {number} parsed value.
 */
function positiveInteger(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer`)
  }
  return value
}

/**
 * Read a non-negative integer environment value.
 * @param {string} name - variable name.
 * @param {number} fallback - default value.
 * @returns {number} parsed value.
 */
function nonNegativeInteger(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
  return value
}

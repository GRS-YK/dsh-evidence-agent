#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkMarkdown } from '../lib/chunker.js'
import { createOpenAICompatibleEmbeddingClient } from '../lib/embedding-client.js'
import {
  buildVectorRecords,
  isVectorRecordReusable,
  parseVectorIndex,
  serializeVectorIndex,
} from '../lib/vector-store.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const envPath = path.join(repoRoot, '.env')
const manifestPath = path.join(repoRoot, 'knowledge', 'manifest.jsonl')
const indexPath = path.join(repoRoot, 'knowledge', 'index', 'vectors.jsonl')
const args = new Set(process.argv.slice(2))
const checkOnly = args.has('--check')
const force = args.has('--force')

run().catch(error => {
  console.error(`Embedding index failed: ${error.message}`)
  process.exitCode = 1
})

async function run() {
  loadLocalEnv(envPath)

  const config = readConfig()
  const { documents, chunks, metadataByDocId } = await loadChunks()
  const existingRecords = await loadExistingRecords()
  const reusableVectors = new Map()

  if (!force) {
    const chunksById = new Map(chunks.map(chunk => [chunk.chunk_id, chunk]))
    for (const record of existingRecords) {
      const chunk = chunksById.get(record.chunk_id)
      if (isVectorRecordReusable(record, chunk, config.model, config.dimension)) {
        reusableVectors.set(record.chunk_id, record.embedding)
      }
    }
  }

  const missingChunks = chunks.filter(chunk => !reusableVectors.has(chunk.chunk_id))

  if (checkOnly) {
    if (missingChunks.length > 0) {
      console.error(
        `Vector index is incomplete: ${missingChunks.length} of ${chunks.length} chunks need embedding`,
      )
      process.exitCode = 1
      process.exit()
    }

    const expected = buildRecords(chunks, reusableVectors, metadataByDocId, config)
    const existingText = await readFile(indexPath, 'utf8').catch(() => '')
    if (existingText !== serializeVectorIndex(expected)) {
      console.error('Vector index is stale; run npm run embeddings:build')
      process.exitCode = 1
    } else {
      console.log(`Vector index is up to date (${expected.length} chunks)`)
    }
    process.exit()
  }

  if (missingChunks.length > 0 && !config.apiKey) {
    throw new Error(
      'EMBEDDING_API_KEY is missing. Copy .env.example to .env and add the key locally.',
    )
  }

  console.log(
    `Knowledge corpus: ${documents.length} documents, ${chunks.length} chunks, `
    + `${missingChunks.length} to embed`,
  )

  if (missingChunks.length > 0) {
    const client = createOpenAICompatibleEmbeddingClient({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      dimension: config.dimension,
      timeoutMs: config.timeoutMs,
      maxRetries: config.maxRetries,
    })

    for (let start = 0; start < missingChunks.length; start += config.batchSize) {
      const batch = missingChunks.slice(start, start + config.batchSize)
      const vectors = await client.embed(batch.map(chunk => chunk.text))
      vectors.forEach((vector, index) => {
        reusableVectors.set(batch[index].chunk_id, vector)
      })
      const completed = Math.min(start + batch.length, missingChunks.length)
      console.log(`Embedded ${completed}/${missingChunks.length}`)
    }
  }

  const records = buildRecords(chunks, reusableVectors, metadataByDocId, config)
  const output = serializeVectorIndex(records)
  await mkdir(path.dirname(indexPath), { recursive: true })
  const temporaryPath = `${indexPath}.tmp-${process.pid}`
  await writeFile(temporaryPath, output, 'utf8')
  await rename(temporaryPath, indexPath)

  console.log(
    `Wrote knowledge/index/vectors.jsonl (${records.length} chunks, `
    + `${config.model}, ${config.dimension} dimensions)`,
  )
}

/**
 * Load simple KEY=VALUE entries without adding a runtime dependency.
 * Existing process environment variables take precedence.
 * @param {string} filePath - local .env path.
 */
function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) return

  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    let value = rawValue.trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

/**
 * Read and validate embedding configuration from environment variables.
 * @returns {object} normalized configuration.
 */
function readConfig() {
  return {
    baseUrl: process.env.EMBEDDING_BASE_URL?.trim() || 'https://api.siliconflow.cn/v1',
    apiKey: process.env.EMBEDDING_API_KEY?.trim() || '',
    model: process.env.EMBEDDING_MODEL?.trim() || 'BAAI/bge-m3',
    dimension: positiveInteger('EMBEDDING_DIMENSION', 1024),
    batchSize: positiveInteger('EMBEDDING_BATCH_SIZE', 16),
    timeoutMs: positiveInteger('EMBEDDING_TIMEOUT_MS', 30_000),
    maxRetries: nonNegativeInteger('EMBEDDING_MAX_RETRIES', 2),
  }
}

/**
 * Load source documents and produce current chunks.
 * @returns {Promise<object>} documents, chunks, and metadata lookup.
 */
async function loadChunks() {
  const documents = (await readFile(manifestPath, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const chunks = []
  const metadataByDocId = {}

  for (const document of documents) {
    const markdown = await readFile(path.join(repoRoot, document.canonical_path), 'utf8')
    const documentChunks = chunkMarkdown(markdown, {
      docId: document.doc_id,
      title: document.title,
    })
    chunks.push(...documentChunks)
    metadataByDocId[document.doc_id] = document
  }

  return { documents, chunks, metadataByDocId }
}

/**
 * Parse an existing index when available.
 * @returns {Promise<object[]>} existing vector records.
 */
async function loadExistingRecords() {
  try {
    return parseVectorIndex(await readFile(indexPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    if (checkOnly) throw error
    console.warn(`Ignoring invalid existing vector index: ${error.message}`)
    return []
  }
}

/**
 * Build the final ordered vector records.
 * @param {object[]} chunks - current chunks.
 * @param {Map<string, number[]>} vectors - vectors by chunk ID.
 * @param {Record<string, object>} metadataByDocId - source metadata.
 * @param {object} config - embedding configuration.
 * @returns {object[]} vector records.
 */
function buildRecords(chunks, vectors, metadataByDocId, config) {
  return buildVectorRecords({
    chunks,
    vectors: chunks.map(chunk => vectors.get(chunk.chunk_id)),
    model: config.model,
    dimension: config.dimension,
    metadataByDocId,
  })
}

/**
 * Read a positive integer environment value.
 * @param {string} name - environment variable name.
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
 * @param {string} name - environment variable name.
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

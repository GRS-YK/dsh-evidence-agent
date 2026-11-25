#!/usr/bin/env node

import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildBM25Index,
  parseBM25Index,
  serializeBM25Index,
} from '../lib/bm25.js'
import { chunkMarkdown } from '../lib/chunker.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const manifestPath = path.join(repoRoot, 'knowledge', 'manifest.jsonl')
const indexPath = path.join(repoRoot, 'knowledge', 'index', 'bm25.json')
const checkOnly = process.argv.includes('--check')

run().catch(error => {
  console.error(`BM25 index failed: ${error.message}`)
  process.exitCode = 1
})

async function run() {
  const { chunks, metadataByDocId } = await loadChunks()
  const expected = buildBM25Index({ chunks, metadataByDocId })
  const expectedText = serializeBM25Index(expected)
  const existingText = await readFile(indexPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''
    throw error
  })

  if (checkOnly) {
    if (!existingText) {
      console.error('BM25 index is missing; run npm.cmd run bm25:build')
      process.exitCode = 1
      return
    }

    try {
      const existing = parseBM25Index(existingText)
      if (existing.corpus_sha256 !== expected.corpus_sha256) {
        console.error('BM25 index is stale; run npm.cmd run bm25:build')
        process.exitCode = 1
        return
      }
    } catch (error) {
      console.error(`BM25 index is invalid: ${error.message}`)
      process.exitCode = 1
      return
    }

    if (existingText !== expectedText) {
      console.error('BM25 index parameters or records differ; run npm.cmd run bm25:build')
      process.exitCode = 1
      return
    }
    console.log(`BM25 index is up to date (${expected.chunk_count} chunks)`)
    return
  }

  await mkdir(path.dirname(indexPath), { recursive: true })
  const temporaryPath = `${indexPath}.tmp-${process.pid}`
  await writeFile(temporaryPath, expectedText, 'utf8')
  await rename(temporaryPath, indexPath)

  console.log(
    `Wrote knowledge/index/bm25.json (${expected.chunk_count} chunks, `
    + `${Object.keys(expected.document_frequencies).length} terms)`,
  )
}

/**
 * Load manifest entries and produce the current structural chunks.
 * @returns {Promise<object>} chunks and source metadata.
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
    chunks.push(...chunkMarkdown(markdown, {
      docId: document.doc_id,
      title: document.title,
    }))
    metadataByDocId[document.doc_id] = document
  }

  return { chunks, metadataByDocId }
}

#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseBM25Index, searchBM25 } from '../lib/bm25.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const indexPath = path.join(repoRoot, 'knowledge', 'index', 'bm25.json')
const args = process.argv.slice(2)
let settings = { query: '', topK: 5 }
try {
  settings = parseArguments(args)
} catch (error) {
  console.error(`Invalid BM25 search arguments: ${error.message}`)
  console.error('Usage: npm.cmd run bm25:search -- "query" [--top-k 5]')
  process.exitCode = 2
}

if (!settings.query && process.exitCode === undefined) {
  console.error('Usage: npm.cmd run bm25:search -- "query" [--top-k 5]')
  process.exitCode = 2
} else if (settings.query) {
  run().catch(error => {
    console.error(`BM25 search failed: ${error.message}`)
    process.exitCode = 1
  })
}

async function run() {
  const index = parseBM25Index(await readFile(indexPath, 'utf8'))
  const results = searchBM25(index, settings.query, { topK: settings.topK })

  console.log(`Query: ${settings.query}`)
  if (results.length === 0) {
    console.log('No lexical matches.')
    return
  }

  for (const [indexPosition, result] of results.entries()) {
    console.log(
      `\n${indexPosition + 1}. score=${result.score.toFixed(4)} `
      + `${result.chunk_id} lines=${result.line_start}-${result.line_end}`,
    )
    console.log(
      `   ${result.document_title} > ${result.heading_path.join(' > ') || result.section}`,
    )
    console.log(`   matched: ${result.matched_terms.join(', ')}`)
    console.log(`   ${makeSnippet(result.text)}`)
    if (result.source_url) console.log(`   source: ${result.source_url}`)
  }
}

/**
 * Parse query and optional limit from command-line arguments.
 * @param {string[]} values - arguments after the script name.
 * @returns {{query: string, topK: number}} parsed arguments.
 */
function parseArguments(values) {
  const queryParts = []
  let topK = 5

  for (let index = 0; index < values.length; index++) {
    const value = values[index]
    if (value === '--') continue
    if (value === '--top-k') {
      const rawLimit = values[++index]
      topK = Number(rawLimit)
      if (!Number.isInteger(topK) || topK < 1) {
        throw new RangeError('--top-k must be a positive integer')
      }
      continue
    }
    queryParts.push(value)
  }

  return { query: queryParts.join(' ').trim(), topK }
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

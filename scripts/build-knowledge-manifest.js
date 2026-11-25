#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildKnowledgeManifest,
  serializeManifest,
} from '../lib/knowledge-manifest.js'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const catalogPath = path.join(repoRoot, 'knowledge', 'sources.json')
const outputPath = path.join(repoRoot, 'knowledge', 'manifest.jsonl')

const catalog = JSON.parse(await readFile(catalogPath, 'utf8'))
const records = await buildKnowledgeManifest({ catalog, repoRoot })
const output = serializeManifest(records)

if (process.argv.includes('--check')) {
  let existing = ''
  try {
    existing = await readFile(outputPath, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  if (existing !== output) {
    console.error('knowledge/manifest.jsonl is stale; run npm run knowledge:manifest')
    process.exitCode = 1
  } else {
    console.log(`knowledge/manifest.jsonl is up to date (${records.length} documents)`)
  }
} else {
  await writeFile(outputPath, output, 'utf8')
  console.log(`Wrote knowledge/manifest.jsonl (${records.length} documents)`)
}

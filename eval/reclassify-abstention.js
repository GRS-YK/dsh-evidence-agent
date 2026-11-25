#!/usr/bin/env node

/**
 * Recompute the derived abstention flag without changing answer text.
 * @module dsh-evidence-agent/eval/reclassify-abstention
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { detectAbstention } from '../lib/answer-evaluation.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const files = process.argv.slice(2)
if (files.length === 0) throw new Error('Pass one or more prediction JSONL files')

for (const file of files) {
  const filePath = path.isAbsolute(file) ? file : path.resolve(REPO_ROOT, file)
  const rows = (await readFile(filePath, 'utf8'))
    .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  const updated = rows.map(row => ({
    ...row,
    abstained: detectAbstention(row.answer),
    evidence_tool_calls: row.evidence_tool_calls ?? 0,
    skill_loads: row.skill_loads ?? 0,
  }))
  await writeFile(filePath, updated.map(row => JSON.stringify(row)).join('\n') + '\n')
  console.log(
    `${path.relative(REPO_ROOT, filePath)}: `
    + `${updated.filter(row => row.abstained).length}/${updated.length} abstained`,
  )
}

#!/usr/bin/env node

/**
 * Score generated answers, citations, refusals, and optional judge labels.
 * @module dsh-evidence-agent/eval/run-answer-eval
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  evaluateAnswers,
  formatAnswerReport,
  parseJudgements,
  parsePredictions,
} from '../lib/answer-evaluation.js'
import { chunkMarkdown } from '../lib/chunker.js'
import { parseEvaluationDataset } from '../lib/evaluation.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
if (!args.predictions) {
  throw new Error(
    'Usage: npm.cmd run eval:answers -- --predictions <answers.jsonl> '
    + '[--judgements <judgements.jsonl>]',
  )
}

const corpus = await loadCorpus()
const chunksById = new Map(corpus.chunks.map(chunk => [chunk.chunk_id, chunk]))
const questions = parseEvaluationDataset(
  await readFile(path.join(REPO_ROOT, 'eval', 'questions.jsonl'), 'utf8'),
  { chunksById },
)
const predictions = parsePredictions((await Promise.all(
  args.predictions.split(',').map(async filePath => (
    await readFile(resolvePath(filePath), 'utf8')
  )),
)).join('\n'))
const judgements = args.judgements
  ? parseJudgements((await Promise.all(
    args.judgements.split(',').map(async filePath => (
      await readFile(resolvePath(filePath), 'utf8')
    )),
  )).join('\n'))
  : []
const report = evaluateAnswers({
  questions,
  chunksById,
  predictions,
  judgements,
})

const reportDir = path.join(REPO_ROOT, 'eval', 'reports')
await mkdir(reportDir, { recursive: true })
await writeFile(
  path.join(reportDir, 'answer-eval.json'),
  JSON.stringify(report, null, 2) + '\n',
)
await writeFile(
  path.join(reportDir, 'answer-eval.md'),
  formatAnswerReport(report),
)
console.log(formatAnswerReport(report))
console.log('Wrote answer evaluation report: eval/reports/answer-eval.md')

async function loadCorpus() {
  const documents = (await readFile(
    path.join(REPO_ROOT, 'knowledge', 'manifest.jsonl'),
    'utf8',
  )).trim().split(/\r?\n/).map(line => JSON.parse(line))
  const chunks = []
  for (const document of documents) {
    const markdown = await readFile(path.join(REPO_ROOT, document.canonical_path), 'utf8')
    chunks.push(...chunkMarkdown(markdown, {
      docId: document.doc_id,
      title: document.title,
    }))
  }
  return { documents, chunks }
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--predictions' || argument === '--judgements') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${argument} requires a file path`)
      }
      parsed[argument.slice(2)] = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return parsed
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(REPO_ROOT, filePath)
}

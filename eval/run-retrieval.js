#!/usr/bin/env node

/**
 * Reproducible retrieval-only evaluation for the evidence agent.
 * @module dsh-evidence-agent/eval/run-retrieval
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBM25Index, searchBM25 } from '../lib/bm25.js'
import { chunkMarkdown } from '../lib/chunker.js'
import {
  EVALUATION_TYPES,
  formatRetrievalReport,
  parseEvaluationDataset,
  summarizeRetrievalRun,
} from '../lib/evaluation.js'
import { EvidenceService } from '../lib/evidence-service.js'
import { hybridSearch, rrfFuse, searchDense } from '../lib/retrieval.js'
import { parseVectorIndex } from '../lib/vector-store.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const QUESTION_PATH = path.join(REPO_ROOT, 'eval', 'questions.jsonl')
const REPORT_DIR = path.join(REPO_ROOT, 'eval', 'reports')
const TOP_K = 5
const CANDIDATE_K = 20
const BATCH_SIZE = 16
const LEXICAL_ONLY = process.argv.includes('--lexical-only')

const questionsText = await readFile(QUESTION_PATH, 'utf8')
const corpus = await loadCorpus()
const chunksById = new Map(corpus.chunks.map(chunk => [chunk.chunk_id, chunk]))
const questions = parseEvaluationDataset(questionsText, { chunksById })
const bm25Index = buildBM25Index({
  chunks: corpus.chunks,
  metadataByDocId: corpus.metadataByDocId,
})
const vectorRecords = LEXICAL_ONLY
  ? []
  : parseVectorIndex(await readFile(
    path.join(REPO_ROOT, 'knowledge', 'index', 'vectors.jsonl'),
    'utf8',
  ))
const queryEmbeddings = LEXICAL_ONLY
  ? new Map()
  : await embedQueries(questions)

const strategies = {
  no_rag: {
    description: 'No retrieval baseline. Retrieval metrics are not applicable.',
  },
  hybrid_raw_question: evaluateStrategy(question => {
    const hits = hybridForQuestion(question.question)
    return { hits, evidenceCalls: 1 }
  }),
  lexical: evaluateStrategy(question => {
    const hits = searchBM25(
      bm25Index,
      question.retrieval_queries[0],
      { topK: TOP_K },
    )
    return { hits, evidenceCalls: 1 }
  }),
}

if (!LEXICAL_ONLY) {
  strategies.dense = evaluateStrategy(question => {
    const hits = searchDense(
      vectorRecords,
      queryEmbeddings.get(question.retrieval_queries[0]),
      { topK: TOP_K },
    )
    return { hits, evidenceCalls: 1 }
  })

  strategies.hybrid = evaluateStrategy(question => {
    const hits = hybridForQuestion(question.retrieval_queries[0])
    return { hits, evidenceCalls: 1 }
  })

  strategies.multi_query = evaluateStrategy(question => {
    const rankedLists = question.retrieval_queries.map((query, index) => ({
      source: `query_${index + 1}`,
      results: hybridForQuestion(query, { topK: 10 }),
    }))
    const hits = rrfFuse(rankedLists, {
      rankConstant: 60,
      topK: TOP_K,
    })
    return {
      hits,
      evidenceCalls: question.retrieval_queries.length,
    }
  })
}

const report = {
  generated_at: new Date().toISOString(),
  dataset: {
    path: 'eval/questions.jsonl',
    total: questions.length,
    by_type: Object.fromEntries(EVALUATION_TYPES.map(type => [
      type,
      questions.filter(question => question.type === type).length,
    ])),
  },
  retrieval: {
    top_k: TOP_K,
    candidate_k: LEXICAL_ONLY ? null : CANDIDATE_K,
    rank_constant: LEXICAL_ONLY ? null : 60,
    bm25: {
      k1: bm25Index.k1,
      b: bm25Index.b,
      chunk_count: bm25Index.chunk_count,
    },
    embedding: LEXICAL_ONLY
      ? null
      : {
        model: vectorRecords[0]?.embedding_model ?? null,
        dimension: vectorRecords[0]?.embedding_dimension ?? null,
        unique_queries: queryEmbeddings.size,
      },
  },
  strategies,
  notes: [
    '> This report evaluates retrieval only. Answer correctness, faithfulness, citation usefulness, and refusal quality are not measured here.',
    '> `hybrid_raw_question` uses the user-facing question unchanged. The other strategies use the dataset retrieval queries, which approximate a rewrite step.',
    '> `multi_query` uses the authored subqueries in the dataset and is an Agentic RAG retrieval proxy, not a live LLM planning run.',
    '> `average_search_ms` measures retrieval work after query embeddings are prepared; it excludes embedding API latency.',
    '> The unanswerable column is evidence-return rate, not refusal rate. A generator can still correctly abstain when candidates are returned.',
    ...LEXICAL_ONLY
      ? ['> This report was generated with `--lexical-only`; dense, hybrid, and multi-query rows are intentionally absent.']
      : [],
  ],
}

await mkdir(REPORT_DIR, { recursive: true })
await writeFile(
  path.join(REPORT_DIR, 'retrieval-baseline.json'),
  JSON.stringify(report, null, 2) + '\n',
)
await writeFile(
  path.join(REPORT_DIR, 'retrieval-baseline.md'),
  formatRetrievalReport(report),
)

console.log(formatRetrievalReport(report))
console.log('Wrote evaluation report: eval/reports/retrieval-baseline.md')

async function loadCorpus() {
  const documents = (await readFile(
    path.join(REPO_ROOT, 'knowledge', 'manifest.jsonl'),
    'utf8',
  )).trim().split(/\r?\n/).map(line => JSON.parse(line))
  const chunks = []
  const metadataByDocId = Object.fromEntries(
    documents.map(document => [document.doc_id, document]),
  )
  for (const document of documents) {
    const markdown = await readFile(path.join(REPO_ROOT, document.canonical_path), 'utf8')
    chunks.push(...chunkMarkdown(markdown, {
      docId: document.doc_id,
      title: document.title,
    }))
  }
  return { documents, chunks, metadataByDocId }
}

async function embedQueries(questions) {
  const service = new EvidenceService({ repoRoot: REPO_ROOT })
  const client = service.getEmbeddingClient()
  const texts = Array.from(new Set(
    questions.flatMap(question => [
      question.question,
      ...question.retrieval_queries,
    ]),
  ))
  const vectors = []
  for (let offset = 0; offset < texts.length; offset += BATCH_SIZE) {
    const batch = texts.slice(offset, offset + BATCH_SIZE)
    const batchVectors = await client.embed(batch)
    if (batchVectors.length !== batch.length) {
      throw new Error('Embedding batch length mismatch')
    }
    vectors.push(...batchVectors)
  }
  return new Map(texts.map((text, index) => [text, vectors[index]]))
}

function evaluateStrategy(runQuestion) {
  const runs = {}
  for (const question of questions) {
    const started = performance.now()
    try {
      const outcome = runQuestion(question)
      runs[question.id] = {
        hits: outcome.hits,
        evidenceCalls: outcome.evidenceCalls,
        latencyMs: performance.now() - started,
      }
    } catch (error) {
      runs[question.id] = {
        error: error instanceof Error ? error.message : String(error),
        evidenceCalls: 0,
        latencyMs: performance.now() - started,
      }
    }
  }
  return {
    ...summarizeRetrievalRun({
      questions,
      runs,
      topK: TOP_K,
    }),
    per_question: Object.fromEntries(questions.map(question => {
      const run = runs[question.id]
      return [question.id, {
        type: question.type,
        question: question.question,
        gold_chunk_ids: question.gold_chunk_ids,
        ranked_chunk_ids: run.hits?.map(hit => hit.chunk_id) ?? [],
        error: run.error,
        latency_ms: run.latencyMs,
        evidence_calls: run.evidenceCalls,
      }]
    })),
  }
}

function hybridForQuestion(query, { topK = TOP_K } = {}) {
  return hybridSearch({
    bm25Index,
    vectorRecords,
    query,
    queryEmbedding: queryEmbeddings.get(query),
    candidateK: CANDIDATE_K,
    topK,
  }).results
}

/**
 * Dataset validation and retrieval metrics for reproducible RAG evaluation.
 * @module dsh-evidence-agent/lib/evaluation
 */

export const EVALUATION_TYPES = Object.freeze([
  'single_hop',
  'multi_hop',
  'unanswerable',
])

export const DEFAULT_EXPECTED_COUNTS = Object.freeze({
  total: 60,
  single_hop: 35,
  multi_hop: 15,
  unanswerable: 10,
})

/**
 * Parse and validate a JSONL evaluation dataset.
 * @param {string} text - JSONL source.
 * @param {object} [options] - validation options.
 * @param {Map<string, object>|object|null} [options.chunksById] - corpus lookup.
 * @param {object} [options.expectedCounts] - required question counts.
 * @returns {object[]} validated questions.
 */
export function parseEvaluationDataset(
  text,
  {
    chunksById = null,
    expectedCounts = DEFAULT_EXPECTED_COUNTS,
  } = {},
) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Evaluation dataset must be a non-empty JSONL file')
  }

  const questions = text.trimEnd().split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`Invalid evaluation JSON on line ${index + 1}`, { cause: error })
    }
  })

  validateEvaluationDataset(questions, { chunksById, expectedCounts })
  return questions
}

/**
 * Validate the structure and coverage of evaluation questions.
 * @param {unknown} questions - candidate dataset.
 * @param {object} [options] - validation options.
 * @param {Map<string, object>|object|null} [options.chunksById] - corpus lookup.
 * @param {object|null} [options.expectedCounts] - required counts; null skips them.
 */
export function validateEvaluationDataset(
  questions,
  { chunksById = null, expectedCounts = DEFAULT_EXPECTED_COUNTS } = {},
) {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error('Evaluation dataset must contain questions')
  }

  const ids = new Set()
  const typeCounts = Object.fromEntries(EVALUATION_TYPES.map(type => [type, 0]))

  questions.forEach((question, index) => {
    const label = `question ${index + 1}`
    if (!isRecord(question)) throw new Error(`${label} must be an object`)
    if (typeof question.id !== 'string' || question.id === '') {
      throw new Error(`${label} must have a non-empty id`)
    }
    if (ids.has(question.id)) throw new Error(`Duplicate evaluation id: ${question.id}`)
    ids.add(question.id)

    if (!EVALUATION_TYPES.includes(question.type)) {
      throw new Error(`${question.id} has invalid type: ${question.type}`)
    }
    typeCounts[question.type] += 1

    requireNonEmptyString(question.question, `${question.id}.question`)
    requireNonEmptyString(question.reference_answer, `${question.id}.reference_answer`)
    requireStringArray(question.retrieval_queries, `${question.id}.retrieval_queries`)
    requireStringArray(question.gold_doc_ids, `${question.id}.gold_doc_ids`)
    requireStringArray(question.gold_chunk_ids, `${question.id}.gold_chunk_ids`)

    if (question.type === 'multi_hop') {
      if (
        question.retrieval_queries.length < 2
        || question.retrieval_queries.length > 3
      ) {
        throw new Error(`${question.id} must define 2-3 multi-hop retrieval queries`)
      }
      if (question.gold_chunk_ids.length < 2) {
        throw new Error(`${question.id} must reference at least two gold chunks`)
      }
    } else if (question.retrieval_queries.length !== 1) {
      throw new Error(`${question.id} must define exactly one retrieval query`)
    }

    if (question.type === 'unanswerable') {
      if (question.gold_doc_ids.length !== 0 || question.gold_chunk_ids.length !== 0) {
        throw new Error(`${question.id} must not define gold evidence`)
      }
    } else if (question.gold_doc_ids.length === 0 || question.gold_chunk_ids.length === 0) {
      throw new Error(`${question.id} must define gold evidence`)
    }

    if (chunksById) {
      const lookup = chunksById instanceof Map
        ? chunksById
        : new Map(Object.entries(chunksById))
      for (const chunkId of question.gold_chunk_ids) {
        const chunk = lookup.get(chunkId)
        if (!chunk) throw new Error(`${question.id} references unknown chunk ${chunkId}`)
        if (!question.gold_doc_ids.includes(chunk.doc_id)) {
          throw new Error(
            `${question.id} does not list ${chunk.doc_id} for gold chunk ${chunkId}`,
          )
        }
      }
    }
  })

  if (expectedCounts) {
    if (questions.length !== expectedCounts.total) {
      throw new Error(
        `Evaluation dataset must contain ${expectedCounts.total} questions; got ${questions.length}`,
      )
    }
    for (const type of EVALUATION_TYPES) {
      if (typeCounts[type] !== expectedCounts[type]) {
        throw new Error(
          `Evaluation dataset must contain ${expectedCounts[type]} ${type} questions; `
          + `got ${typeCounts[type]}`,
        )
      }
    }
  }
}

/**
 * Score one ranked list against gold chunk IDs.
 * @param {string[]} goldChunkIds - relevant chunks.
 * @param {string[]} rankedChunkIds - predicted order.
 * @param {number} [k=5] - cutoff.
 * @returns {{hit: boolean, recall: number|null, reciprocal_rank: number}}
 *   per-question retrieval score.
 */
export function scoreRanking(goldChunkIds, rankedChunkIds, k = 5) {
  if (!Array.isArray(goldChunkIds) || !Array.isArray(rankedChunkIds)) {
    throw new TypeError('goldChunkIds and rankedChunkIds must be arrays')
  }
  if (!Number.isInteger(k) || k < 1) throw new RangeError('k must be a positive integer')

  const top = rankedChunkIds.slice(0, k)
  if (goldChunkIds.length === 0) {
    return {
      hit: false,
      recall: null,
      reciprocal_rank: 0,
    }
  }

  const gold = new Set(goldChunkIds)
  const retrieved = new Set(top.filter(chunkId => gold.has(chunkId)))
  const firstRelevant = top.findIndex(chunkId => gold.has(chunkId))
  return {
    hit: firstRelevant >= 0,
    recall: retrieved.size / gold.size,
    reciprocal_rank: firstRelevant >= 0 ? 1 / (firstRelevant + 1) : 0,
  }
}

/**
 * Aggregate retrieval metrics. Answerable metrics exclude unanswerable questions;
 * unanswerable evidence-return rate is diagnostic, not a refusal measurement.
 * @param {object} options - aggregation options.
 * @param {object[]} options.questions - validated questions.
 * @param {Record<string, object>} options.runs - results by question ID.
 * @param {number} [options.topK=5] - retrieval cutoff.
 * @returns {object} aggregate metrics.
 */
export function summarizeRetrievalRun({ questions, runs, topK = 5 }) {
  if (!Array.isArray(questions)) throw new TypeError('questions must be an array')
  if (!isRecord(runs)) throw new TypeError('runs must be an object')

  const rows = questions.map(question => {
    const run = runs[question.id]
    if (!isRecord(run)) throw new Error(`Missing run for ${question.id}`)
    if (run.error) {
      return {
        question,
        error: run.error,
        hit: false,
        recall: question.type === 'unanswerable' ? null : 0,
        reciprocal_rank: 0,
        returned_evidence: false,
        latency_ms: finiteNonNegative(run.latencyMs),
        evidence_calls: finiteNonNegative(run.evidenceCalls),
      }
    }
    if (!Array.isArray(run.hits)) throw new Error(`Run ${question.id} must contain hits[]`)
    const rankedChunkIds = run.hits.map((hit, index) => {
      if (!isRecord(hit) || typeof hit.chunk_id !== 'string') {
        throw new Error(`Run ${question.id} hit ${index + 1} has no chunk_id`)
      }
      return hit.chunk_id
    })
    return {
      question,
      ...scoreRanking(question.gold_chunk_ids, rankedChunkIds, topK),
      returned_evidence: rankedChunkIds.length > 0,
      latency_ms: finiteNonNegative(run.latencyMs),
      evidence_calls: finiteNonNegative(run.evidenceCalls),
    }
  })

  const answerable = rows.filter(row => row.question.type !== 'unanswerable')
  const unanswerable = rows.filter(row => row.question.type === 'unanswerable')
  return {
    question_count: rows.length,
    error_count: rows.filter(row => row.error).length,
    recall_at_k: average(answerable.map(row => row.recall)),
    hit_rate_at_k: average(answerable.map(row => row.hit ? 1 : 0)),
    mrr_at_k: average(answerable.map(row => row.reciprocal_rank)),
    unanswerable_evidence_return_rate: average(
      unanswerable.map(row => row.returned_evidence ? 1 : 0),
    ),
    average_search_ms: average(rows.map(row => row.latency_ms)),
    average_evidence_calls: average(rows.map(row => row.evidence_calls)),
    by_type: Object.fromEntries(EVALUATION_TYPES.map(type => {
      const typed = rows.filter(row => row.question.type === type)
      return [type, summarizeType(typed)]
    })),
  }
}

/**
 * Format a retrieval report as Markdown.
 * @param {object} report - report produced by the retrieval runner.
 * @returns {string} Markdown report.
 */
export function formatRetrievalReport(report) {
  const lines = [
    '# Retrieval Evaluation',
    '',
    `Generated: ${report.generated_at}`,
    '',
    report.notes.join('\n'),
    '',
    '## Overall',
    '',
    '| Strategy | Recall@5 | HitRate@5 | MRR@5 | Unanswerable evidence returned | Avg search ms | Avg evidence calls |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]

  for (const [name, summary] of Object.entries(report.strategies)) {
    if (name === 'no_rag') {
      lines.push('| No RAG | N/A | N/A | N/A | N/A | 0.00 | 0.00 |')
      continue
    }
    lines.push(
      `| ${name} | ${formatMetric(summary.recall_at_k)} | `
      + `${formatMetric(summary.hit_rate_at_k)} | ${formatMetric(summary.mrr_at_k)} | `
      + `${formatMetric(summary.unanswerable_evidence_return_rate)} | `
      + `${formatNumber(summary.average_search_ms)} | `
      + `${formatNumber(summary.average_evidence_calls)} |`,
    )
  }

  lines.push('', '## By question type', '')
  for (const [strategy, summary] of Object.entries(report.strategies)) {
    if (strategy === 'no_rag') continue
    lines.push(
      `### ${strategy}`,
      '',
      '| Type | Count | Recall@5 | HitRate@5 | MRR@5 |',
      '| --- | ---: | ---: | ---: | ---: |',
    )
    for (const type of EVALUATION_TYPES) {
      const metrics = summary.by_type[type]
      lines.push(
        `| ${type} | ${metrics.count} | ${formatMetric(metrics.recall_at_k)} | `
        + `${formatMetric(metrics.hit_rate_at_k)} | ${formatMetric(metrics.mrr_at_k)} |`,
      )
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/**
 * Summarize one question type.
 * @param {object[]} rows - scored rows.
 * @returns {object} type metrics.
 */
function summarizeType(rows) {
  const answerable = rows.filter(row => row.question.type !== 'unanswerable')
  return {
    count: rows.length,
    recall_at_k: average(answerable.map(row => row.recall)),
    hit_rate_at_k: average(answerable.map(row => row.hit ? 1 : 0)),
    mrr_at_k: average(answerable.map(row => row.reciprocal_rank)),
    evidence_return_rate: average(rows.map(row => row.returned_evidence ? 1 : 0)),
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item === '')) {
    throw new Error(`${label} must be an array of non-empty strings`)
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function average(values) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

function formatMetric(value) {
  return value === null ? 'N/A' : formatNumber(value)
}

function formatNumber(value) {
  return value === null ? 'N/A' : value.toFixed(4)
}

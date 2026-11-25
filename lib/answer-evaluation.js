/**
 * Validation and scoring for end-to-end answer evaluation artifacts.
 * @module dsh-evidence-agent/lib/answer-evaluation
 */

export const ANSWER_STRATEGIES = Object.freeze([
  'no_rag',
  'dense',
  'hybrid',
  'agentic',
])

export function parsePredictions(text) {
  return parseJsonLines(text, 'answer predictions')
}

export function parseJudgements(text) {
  return parseJsonLines(text, 'answer judgements')
}

/**
 * Detect explicit inability or corpus-refusal language in the opening of an
 * answer. This derives a metric flag; it does not modify generated answer text.
 * @param {string} answer - generated answer.
 * @returns {boolean} whether the answer explicitly abstains or reports inability.
 */
export function detectAbstention(answer) {
  if (typeof answer !== 'string') throw new TypeError('answer must be a string')
  const head = answer.slice(0, 800).toLocaleLowerCase()
  return [
    '根据当前知识库无法确认',
    '无法可靠回答',
    '无法可靠判断',
    '无法回答',
    '无法确定',
    '不知道',
    '没有足够信息',
    '信息不足',
    '没有预训练知识',
    'cannot confirm',
    'cannot answer',
    "can't answer",
    'cannot reliably',
    'do not know',
    "don't know",
    'unable to answer',
    'unable to determine',
    'no reliable information',
  ].some(marker => head.includes(marker))
}

/**
 * Evaluate answer predictions. Correctness and faithfulness are read from
 * separate judgement records; citation and refusal checks are deterministic.
 * @param {object} options - evaluation inputs.
 * @param {object[]} options.questions - validated questions.
 * @param {Map<string, object>} options.chunksById - corpus chunk lookup.
 * @param {object[]} options.predictions - generated answer records.
 * @param {object[]} [options.judgements] - human or judge labels.
 * @returns {object} answer evaluation report.
 */
export function evaluateAnswers({
  questions,
  chunksById,
  predictions,
  judgements = [],
}) {
  const questionById = new Map(questions.map(question => [question.id, question]))
  const judgementByKey = new Map()

  for (const judgement of judgements) {
    const key = answerKey(judgement.strategy, judgement.id)
    if (judgementByKey.has(key)) throw new Error(`Duplicate judgement: ${key}`)
    if (!questionById.has(judgement.id)) {
      throw new Error(`Judgement references unknown question: ${judgement.id}`)
    }
    if (!ANSWER_STRATEGIES.includes(judgement.strategy)) {
      throw new Error(`Judgement has invalid strategy: ${judgement.strategy}`)
    }
    validateBoolean(judgement.correct, `${key}.correct`)
    if (judgement.faithful !== null) {
      validateBoolean(judgement.faithful, `${key}.faithful`)
    }
    judgementByKey.set(key, judgement)
  }

  const predictionByKey = new Map()
  for (const prediction of predictions) {
    if (!isRecord(prediction)) throw new Error('Every prediction must be an object')
    const key = answerKey(prediction.strategy, prediction.id)
    if (predictionByKey.has(key)) throw new Error(`Duplicate prediction: ${key}`)
    if (!questionById.has(prediction.id)) {
      throw new Error(`Prediction references unknown question: ${prediction.id}`)
    }
    if (!ANSWER_STRATEGIES.includes(prediction.strategy)) {
      throw new Error(`Prediction has invalid strategy: ${prediction.strategy}`)
    }
    if (typeof prediction.answer !== 'string') {
      throw new Error(`${key}.answer must be a string`)
    }
    validateBoolean(prediction.abstained, `${key}.abstained`)
    validateCitations(prediction.citations, `${key}.citations`)
    predictionByKey.set(key, prediction)
  }

  const strategies = {}
  for (const strategy of ANSWER_STRATEGIES) {
    const strategyPredictions = predictions.filter(item => item.strategy === strategy)
    if (strategyPredictions.length === 0) continue
    strategies[strategy] = summarizeStrategy({
      strategy,
      questions,
      chunksById,
      predictions: strategyPredictions,
      judgementByKey,
    })
  }
  const labelSources = Array.from(new Set(
    judgements
      .map(judgement => judgement.label_source)
      .filter(value => typeof value === 'string' && value !== ''),
  ))

  return {
    generated_at: new Date().toISOString(),
    expected_questions: questions.length,
    strategies,
    label_sources: labelSources,
    notes: [
      '> Answer correctness and faithfulness are N/A until explicit judgement records cover the answers.',
      '> Citation accuracy checks cited doc_id and line ranges against gold chunks from the evaluation dataset.',
      '> Refusal accuracy is computed only for questions whose dataset type is `unanswerable`.',
      '> A returned candidate is not itself an incorrect answer; generation and refusal are evaluated separately.',
    ],
  }
}

/**
 * Check whether one citation range overlaps a gold chunk for its question.
 * @param {object} citation - structured citation.
 * @param {object} question - evaluation question.
 * @param {Map<string, object>} chunksById - corpus lookup.
 * @returns {{valid: boolean, supported: boolean}} locator and gold checks.
 */
export function checkCitation(citation, question, chunksById) {
  validateCitation(citation, 'citation')
  const corpusChunks = Array.from(chunksById.values()).filter(
    chunk => chunk.doc_id === citation.doc_id,
  )
  const valid = corpusChunks.some(chunk => rangesOverlap(
    citation.line_start,
    citation.line_end,
    chunk.line_start,
    chunk.line_end,
  ))
  const gold = question.gold_chunk_ids
    .map(chunkId => chunksById.get(chunkId))
    .filter(Boolean)
  const supported = gold.some(chunk => (
    chunk.doc_id === citation.doc_id
    && rangesOverlap(
      citation.line_start,
      citation.line_end,
      chunk.line_start,
      chunk.line_end,
    )
  ))
  return { valid, supported }
}

/**
 * Format an answer evaluation report as Markdown.
 * @param {object} report - answer evaluation report.
 * @returns {string} Markdown.
 */
export function formatAnswerReport(report) {
  const labelNote = (report.label_sources ?? []).includes('llm')
    ? ['> Some correctness and faithfulness labels came from an automated LLM judge and require human spot-checking.']
    : []
  const lines = [
    '# Answer Evaluation',
    '',
    `Generated: ${report.generated_at}`,
    '',
    [...report.notes, ...labelNote].join('\n'),
    '',
    '| Strategy | Answers | Judged | Answer acc. | Faithfulness | Citation gold acc. | Citation coverage | Refusal acc. | False refusal | Avg latency ms | P95 latency ms | Avg evidence calls | Avg tokens |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ]
  for (const [strategy, summary] of Object.entries(report.strategies)) {
    lines.push(
      `| ${strategy} | ${summary.answer_count}/${summary.expected_answers} | `
      + `${summary.judged_answers} | `
      + `${formatMetric(summary.answer_accuracy)} | ${formatMetric(summary.faithfulness)} | `
      + `${formatMetric(summary.citation_gold_accuracy)} | `
      + `${formatMetric(summary.citation_coverage)} | `
      + `${formatMetric(summary.refusal_accuracy)} | `
      + `${formatMetric(summary.false_refusal_rate)} | `
      + `${formatMetric(summary.average_latency_ms)} | `
      + `${formatMetric(summary.p95_latency_ms)} | `
      + `${formatMetric(summary.average_evidence_tool_calls)} | `
      + `${formatMetric(summary.average_tokens)} |`,
    )
  }
  return lines.join('\n').trimEnd() + '\n'
}

function summarizeStrategy({
  strategy,
  questions,
  chunksById,
  predictions,
  judgementByKey,
}) {
  const predictionByQuestion = new Map(predictions.map(item => [item.id, item]))
  const answerableQuestions = questions.filter(question => question.type !== 'unanswerable')
  const unanswerableQuestions = questions.filter(question => question.type === 'unanswerable')
  const answerablePredictions = answerableQuestions
    .map(question => predictionByQuestion.get(question.id))
    .filter(Boolean)
  const unanswerablePredictions = unanswerableQuestions
    .map(question => predictionByQuestion.get(question.id))
    .filter(Boolean)

  const citationChecks = []
  let answerableWithSupportedCitation = 0
  for (const question of answerableQuestions) {
    const prediction = predictionByQuestion.get(question.id)
    if (!prediction) continue
    const checks = prediction.citations.map(citation => (
      checkCitation(citation, question, chunksById)
    ))
    citationChecks.push(...checks)
    if (checks.some(check => check.supported)) answerableWithSupportedCitation += 1
  }

  const labelled = answerablePredictions
    .map(prediction => judgementByKey.get(answerKey(strategy, prediction.id)))
    .filter(Boolean)
  const correct = labelled.map(judgement => judgement.correct ? 1 : 0)
  const faithful = labelled
    .filter(judgement => typeof judgement.faithful === 'boolean')
    .map(judgement => judgement.faithful ? 1 : 0)
  const allPredictions = predictions.filter(item => predictionByQuestion.has(item.id))

  return {
    expected_answers: questions.length,
    answer_count: predictions.length,
    judged_answers: labelled.length,
    answer_accuracy: average(correct),
    faithfulness: average(faithful),
    citation_gold_accuracy: citationChecks.length === 0
      ? null
      : average(citationChecks.map(check => check.supported ? 1 : 0)),
    citation_locator_validity: citationChecks.length === 0
      ? null
      : average(citationChecks.map(check => check.valid ? 1 : 0)),
    citation_coverage: answerablePredictions.length === 0
      ? null
      : answerableWithSupportedCitation / answerablePredictions.length,
    refusal_accuracy: unanswerablePredictions.length === 0
      ? null
      : average(unanswerablePredictions.map(item => item.abstained ? 1 : 0)),
    false_refusal_rate: answerablePredictions.length === 0
      ? null
      : average(answerablePredictions.map(item => item.abstained ? 1 : 0)),
    average_latency_ms: averageOptional(allPredictions.map(item => item.latency_ms)),
    p95_latency_ms: percentile95(allPredictions.map(item => item.latency_ms)),
    average_evidence_tool_calls: averageOptional(
      allPredictions.map(item => item.evidence_tool_calls),
    ),
    average_tool_calls: averageOptional(allPredictions.map(item => item.tool_calls)),
    average_tokens: averageOptional(allPredictions.map(
      item => optionalSum(item.input_tokens, item.output_tokens),
    )),
    missing_question_ids: questions
      .filter(question => !predictionByQuestion.has(question.id))
      .map(question => question.id),
    unjudged_answer_ids: answerablePredictions
      .filter(prediction => !judgementByKey.has(answerKey(strategy, prediction.id)))
      .map(prediction => prediction.id),
  }
}

function parseJsonLines(text, label) {
  if (typeof text !== 'string' || text.trim() === '') return []
  return text.trimEnd().split(/\r?\n/).filter(line => line.trim() !== '').map((line, index) => {
    try {
      return JSON.parse(line)
    } catch (error) {
      throw new Error(`Invalid ${label} JSON on line ${index + 1}`, { cause: error })
    }
  })
}

function validateCitations(citations, label) {
  if (!Array.isArray(citations)) throw new Error(`${label} must be an array`)
  citations.forEach((citation, index) => validateCitation(
    citation,
    `${label}[${index}]`,
  ))
}

function validateCitation(citation, label) {
  if (!isRecord(citation)) throw new Error(`${label} must be an object`)
  if (typeof citation.doc_id !== 'string' || citation.doc_id === '') {
    throw new Error(`${label}.doc_id must be a non-empty string`)
  }
  for (const field of ['line_start', 'line_end']) {
    if (!Number.isInteger(citation[field]) || citation[field] < 1) {
      throw new Error(`${label}.${field} must be a positive integer`)
    }
  }
  if (citation.line_start > citation.line_end) {
    throw new Error(`${label} line_start must not exceed line_end`)
  }
}

function validateBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`)
}

function rangesOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart <= rightEnd && rightStart <= leftEnd
}

function answerKey(strategy, id) {
  return `${strategy}:${id}`
}

function optionalSum(left, right) {
  if (!Number.isFinite(left) && !Number.isFinite(right)) return undefined
  return (Number.isFinite(left) ? left : 0) + (Number.isFinite(right) ? right : 0)
}

function average(values) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length
}

function averageOptional(values) {
  return average(values.filter(value => typeof value === 'number' && Number.isFinite(value)))
}

function percentile95(values) {
  const sorted = values
    .filter(value => typeof value === 'number' && Number.isFinite(value))
    .sort((left, right) => left - right)
  if (sorted.length === 0) return null
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)]
}

function formatMetric(value) {
  return value === null ? 'N/A' : value.toFixed(4)
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

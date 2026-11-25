#!/usr/bin/env node

/**
 * Generate immutable No RAG, Dense, Hybrid, or Agentic answers through DSH.
 * @module dsh-evidence-agent/eval/generate-answers
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBM25Index } from '../lib/bm25.js'
import { detectAbstention } from '../lib/answer-evaluation.js'
import { chunkMarkdown } from '../lib/chunker.js'
import { parseEvaluationDataset } from '../lib/evaluation.js'
import { EvidenceService } from '../lib/evidence-service.js'
import { hybridSearch, searchDense } from '../lib/retrieval.js'
import { parseVectorIndex } from '../lib/vector-store.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const token = process.env.DSH_EVAL_TOKEN
const workspaceId = args.workspace
const baseUrl = args.baseUrl ?? 'http://127.0.0.1:3082'
const strategy = args.strategy ?? 'hybrid'
if (!['no_rag', 'dense', 'hybrid', 'agentic'].includes(strategy)) {
  throw new Error('--strategy must be no_rag, dense, hybrid, or agentic')
}
if (!token) throw new Error('DSH_EVAL_TOKEN is required')
if (!workspaceId) {
  throw new Error('--workspace is required (the DSH workspaceId for this repository)')
}

const limit = args.limit ? Number(args.limit) : null
if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
  throw new Error('--limit must be a positive integer')
}
const concurrency = args.concurrency ? Number(args.concurrency) : 1
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error('--concurrency must be an integer from 1 to 4')
}
const outputPath = resolvePath(
  args.output ?? `eval/predictions/${strategy}-dsh-${dateStamp()}.jsonl`,
)

const corpus = await loadCorpus()
const chunksById = new Map(corpus.chunks.map(chunk => [chunk.chunk_id, chunk]))
let questions = parseEvaluationDataset(
  await readFile(path.join(REPO_ROOT, 'eval', 'questions.jsonl'), 'utf8'),
  { chunksById },
)
if (limit) questions = questions.slice(0, limit)

const bm25Index = buildBM25Index({
  chunks: corpus.chunks,
  metadataByDocId: corpus.metadataByDocId,
})
const usesPreRetrieval = strategy === 'dense' || strategy === 'hybrid'
const vectorRecords = usesPreRetrieval
  ? parseVectorIndex(await readFile(
    path.join(REPO_ROOT, 'knowledge', 'index', 'vectors.jsonl'),
    'utf8',
  ))
  : []
const queryEmbeddings = usesPreRetrieval
  ? await embedQueries(
    Array.from(new Set(questions.map(question => question.retrieval_queries[0]))),
  )
  : new Map()
const rpc = await createRpcClient({ baseUrl, token })

await mkdir(path.dirname(outputPath), { recursive: true })
if (!args.resume) await writeFile(outputPath, '')
const completed = args.resume ? await readCompletedIds(outputPath) : new Set()
const pending = questions.filter(question => !completed.has(question.id))
let finished = completed.size

console.log(
  `Generating ${pending.length} ${strategy} answers with concurrency=${concurrency}: ${outputPath}`,
)

await runPool(pending, concurrency, async question => {
  const started = performance.now()
  const query = question.retrieval_queries[0]
  const hits = strategy === 'hybrid'
    ? hybridSearch({
      bm25Index,
      vectorRecords,
      query,
      queryEmbedding: queryEmbeddings.get(query),
      candidateK: 20,
      topK: 5,
    }).results
    : strategy === 'dense'
      ? searchDense(vectorRecords, queryEmbeddings.get(query), { topK: 5 })
      : []
  const retrievalMs = performance.now() - started
  const prompt = buildPrompt(strategy, question, hits)
  const session = await rpc.call('session/create', {
    workspaceId,
    agentPreset: strategy === 'agentic' ? 'standard' : 'minimal',
  })
  const sessionId = session.sessionId
  const requestId = `eval-hybrid-${question.id}-${randomUUID()}`
  await rpc.call('session/prompt', {
    requestId,
    sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
    clientTimeZone: 'Asia/Shanghai',
  })

  const generationStarted = performance.now()
  const waited = await waitUntilIdle(rpc, sessionId)
  const generationMs = performance.now() - generationStarted
  const extracted = extractAssistantOutput(waited.output.records)
  if (!extracted.answer.trim()) {
    throw new Error(`${question.id} produced no final text`)
  }

  const prediction = {
    id: question.id,
    strategy,
    answer: extracted.answer,
    citations: extractCitations(extracted.answer),
    abstained: detectAbstention(extracted.answer),
    latency_ms: Math.round(generationMs),
    tool_calls: extracted.toolCalls,
    evidence_tool_calls: extracted.evidenceToolCalls,
    skill_loads: extracted.skillLoads,
    input_tokens: extracted.inputTokens,
    output_tokens: extracted.outputTokens,
    session_id: sessionId,
    ...usesPreRetrieval ? {
      retrieval_ms: Number(retrievalMs.toFixed(3)),
      retrieved_chunk_ids: hits.map(hit => hit.chunk_id),
      retrieval_query: query,
    } : {},
  }
  await appendFile(outputPath, JSON.stringify(prediction) + '\n')
  finished += 1
  console.log(
    `[${finished}/${questions.length}] ${question.id} `
    + `${prediction.abstained ? 'abstained' : 'answered'} `
    + `citations=${prediction.citations.length} tokens=${prediction.input_tokens + prediction.output_tokens}`,
  )
})

console.log(`Wrote ${questions.length} predictions: ${path.relative(REPO_ROOT, outputPath)}`)

async function createRpcClient({ baseUrl, token }) {
  const login = await fetch(`${baseUrl}/?token=${encodeURIComponent(token)}`, {
    redirect: 'manual',
  })
  if (login.status !== 303 && !login.ok) {
    throw new Error(`DSH authentication failed: HTTP ${login.status}`)
  }
  const cookies = login.headers.getSetCookie()
    .map(value => value.split(';', 1)[0])
    .join('; ')
  if (!cookies) throw new Error('DSH authentication did not return a cookie')

  return {
    async call(method, request) {
      const rpcId = `${method}-${randomUUID()}`
      const response = await fetch(`${baseUrl}/api/${method}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookies,
        },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method,
          payload: { args: { request } },
        }),
      })
      if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`)
      const envelope = await response.json()
      if (envelope.rpcId !== rpcId) throw new Error(`${method} returned a mismatched rpcId`)
      if (!envelope.result?.ok) {
        const error = envelope.result?.error
        throw new Error(
          `${method} failed: ${error?.code ?? 'unknown'} ${error?.message ?? 'unknown error'}`,
        )
      }
      return envelope.result.value
    },
  }
}

async function waitUntilIdle(rpc, sessionId) {
  let afterSeq = 0
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await rpc.call('session/wait', {
      sessionId,
      timeoutMs: 60_000,
      afterSeq,
      maxMessages: 50,
    })
    if (value.reason !== 'timeout') return value
    const records = value.output.records
    afterSeq = records.reduce(
      (maximum, record) => Math.max(maximum, record.event?.seq ?? 0),
      afterSeq,
    )
  }
  throw new Error(`Session ${sessionId} did not become idle within three wait windows`)
}

function extractAssistantOutput(records) {
  const messages = records
    .map(record => record.event)
    .filter(event => event?.type === 'assistant/message')
    .sort((left, right) => left.seq - right.seq)
  if (messages.length === 0) throw new Error('No assistant message was returned')

  const allBlocks = messages.flatMap(event => event.data.message.content)
  const text = messages
    .flatMap(event => event.data.message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  const toolCalls = allBlocks.filter(block => block.type === 'tool-call').length
  const evidenceToolCalls = allBlocks.filter(
    block => block.type === 'tool-call'
      && block.name.startsWith('dsh-evidence-agent_kb_'),
  ).length
  const skillLoads = allBlocks.filter(
    block => block.type === 'tool-call' && block.name === 'skill',
  ).length
  const inputTokens = messages.reduce(
    (sum, event) => sum + (event.data.usage?.inputTokens ?? 0),
    0,
  )
  const outputTokens = messages.reduce(
    (sum, event) => sum + (event.data.usage?.outputTokens ?? 0),
    0,
  )
  return {
    answer: text,
    toolCalls,
    evidenceToolCalls,
    skillLoads,
    inputTokens,
    outputTokens,
  }
}

function extractCitations(answer) {
  const citations = []
  const seen = new Set()
  const pattern = /\[([A-Za-z0-9._-]+)#L(\d+)-L(\d+)\]/g
  for (const match of answer.matchAll(pattern)) {
    const citation = {
      doc_id: match[1],
      line_start: Number(match[2]),
      line_end: Number(match[3]),
    }
    const key = `${citation.doc_id}:${citation.line_start}:${citation.line_end}`
    if (!seen.has(key)) {
      seen.add(key)
      citations.push(citation)
    }
  }
  return citations
}

function buildPrompt(strategy, question, hits) {
  if (strategy === 'agentic') {
    return [
      '这是一个独立的 Agentic RAG 评测任务。',
      '必须先加载 dsh-evidence-agent Skill，再按其中的检索策略工作。',
      '只依据知识库工具真实返回的证据回答，不得使用模型记忆补充知识库外事实。',
      '每个关键事实使用真实引用格式 [doc_id#L开始-L结束]。',
      '如果证据不足，回答必须以“根据当前知识库无法确认”开头，并说明缺少什么证据。',
      `问题：${question.question}`,
    ].join('\n')
  }

  if (strategy === 'no_rag') {
    return [
      '这是一个独立的 No RAG 基线评测。',
      '你不能访问本项目知识库，也不会获得检索证据。',
      '请仅凭预训练知识直接回答问题；不知道或无法可靠判断时要明确说明。',
      '不要伪造文件名、doc_id、行号或引用。',
      `问题：${question.question}`,
    ].join('\n')
  }

  const evidence = hits.map((hit, index) => [
    `[${index + 1}] ${hit.doc_id}#L${hit.line_start}-L${hit.line_end}`,
    `title: ${hit.document_title}`,
    hit.section ? `section: ${hit.section}` : null,
    hit.text,
  ].filter(Boolean).join('\n')).join('\n\n')

  return [
    `这是一个独立的 ${strategy === 'dense' ? 'Dense' : 'Hybrid'} 一次性 RAG 评测。`,
    '你没有工具，也不要尝试调用工具。下方证据已经由检索器预先取得。',
    '只依据下方证据回答。不要使用模型常识补充知识库外事实。',
    '如果证据不足以回答，回答必须以“根据当前知识库无法确认”开头，并说明缺少什么证据。',
    '关键事实后使用真实引用格式 [doc_id#L开始-L结束]。',
    '回答完成后不要再重复引用列表。',
    '',
    `问题：${question.question}`,
    '',
    '检索证据：',
    evidence,
  ].join('\n')
}

async function embedQueries(texts) {
  const service = new EvidenceService({ repoRoot: REPO_ROOT })
  const client = service.getEmbeddingClient()
  const vectors = []
  for (let offset = 0; offset < texts.length; offset += 16) {
    vectors.push(...await client.embed(texts.slice(offset, offset + 16)))
  }
  return new Map(texts.map((text, index) => [text, vectors[index]]))
}

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

async function readCompletedIds(filePath) {
  try {
    const text = await readFile(filePath, 'utf8')
    return new Set(text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).id))
  } catch (error) {
    if (error.code === 'ENOENT') return new Set()
    throw error
  }
}

async function runPool(items, size, operation) {
  let next = 0
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      await operation(items[index])
    }
  })
  await Promise.all(workers)
}

function parseArgs(argv) {
  const parsed = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--resume') {
      parsed.resume = true
      continue
    }
    if (!argument.startsWith('--')) throw new Error(`Unknown argument: ${argument}`)
    const value = argv[index + 1]
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`)
    const key = {
      '--base-url': 'baseUrl',
      '--workspace': 'workspace',
      '--limit': 'limit',
      '--concurrency': 'concurrency',
      '--output': 'output',
      '--strategy': 'strategy',
    }[argument]
    if (!key) throw new Error(`Unknown argument: ${argument}`)
    parsed[key] = value
    index += 1
  }
  return parsed
}

function resolvePath(filePath) {
  return path.isAbsolute(filePath) ? filePath : path.resolve(REPO_ROOT, filePath)
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10).replaceAll('-', '')
}

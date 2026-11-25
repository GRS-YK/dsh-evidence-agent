#!/usr/bin/env node

/**
 * Generate provisional LLM correctness and faithfulness labels through DSH.
 * @module dsh-evidence-agent/eval/generate-judgements
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkMarkdown } from '../lib/chunker.js'
import { parseEvaluationDataset } from '../lib/evaluation.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))
const token = process.env.DSH_EVAL_TOKEN
const workspaceId = args.workspace
const baseUrl = args.baseUrl ?? 'http://127.0.0.1:3082'
if (!token) throw new Error('DSH_EVAL_TOKEN is required')
if (!workspaceId) throw new Error('--workspace is required')
if (!args.predictions) throw new Error('--predictions is required')

const outputPath = resolvePath(
  args.output ?? `eval/judgements/${strategy}-dsh-${dateStamp()}.auto.jsonl`,
)
const concurrency = args.concurrency ? Number(args.concurrency) : 2
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error('--concurrency must be an integer from 1 to 4')
}

const corpus = await loadCorpus()
const chunksById = new Map(corpus.chunks.map(chunk => [chunk.chunk_id, chunk]))
const questions = parseEvaluationDataset(
  await readFile(path.join(REPO_ROOT, 'eval', 'questions.jsonl'), 'utf8'),
  { chunksById },
)
const questionById = new Map(questions.map(question => [question.id, question]))
const predictions = (await readFile(resolvePath(args.predictions), 'utf8'))
  .trim().split(/\r?\n/).map(line => JSON.parse(line))
const strategies = new Set(predictions.map(prediction => prediction.strategy))
if (strategies.size !== 1) throw new Error('Judge one prediction strategy at a time')
const strategy = predictions[0]?.strategy
if (!['no_rag', 'dense', 'hybrid', 'agentic'].includes(strategy)) {
  throw new Error(`Unsupported prediction strategy: ${strategy}`)
}

const rpc = await createRpcClient({ baseUrl, token })
await mkdir(path.dirname(outputPath), { recursive: true })
if (!args.resume) await writeFile(outputPath, '')
const completed = args.resume ? await readCompletedIds(outputPath) : new Set()
const pending = predictions.filter(prediction => !completed.has(prediction.id))
console.log(`Judging ${pending.length} answers with concurrency=${concurrency}`)

await runPool(pending, concurrency, async prediction => {
  const question = questionById.get(prediction.id)
  if (!question) throw new Error(`Unknown prediction id: ${prediction.id}`)
  const citedEvidence = evidenceForCitations(prediction.citations, chunksById)
  const prompt = buildJudgePrompt(strategy, question, prediction, citedEvidence)
  const session = await rpc.call('session/create', {
    workspaceId,
    agentPreset: 'minimal',
  })
  await rpc.call('session/prompt', {
    requestId: `eval-judge-${prediction.id}-${randomUUID()}`,
    sessionId: session.sessionId,
    mode: 'queue',
    content: [{ type: 'text', text: prompt }],
    clientTimeZone: 'Asia/Shanghai',
  })
  const waited = await waitUntilIdle(rpc, session.sessionId)
  const answer = extractFinalText(waited.output.records)
  const parsed = parseJudgeJson(answer)
  if (
    typeof parsed.correct !== 'boolean'
    || (strategy === 'no_rag'
      ? parsed.faithful !== null
      : typeof parsed.faithful !== 'boolean')
  ) {
    throw new Error(`${prediction.id} judge returned invalid labels: ${answer.slice(0, 300)}`)
  }
  const judgement = {
    id: prediction.id,
    strategy,
    correct: parsed.correct,
    faithful: parsed.faithful,
    label_source: 'llm',
    judge_model: 'deepseek-flash',
    judge_session_id: session.sessionId,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  }
  await appendFile(outputPath, JSON.stringify(judgement) + '\n')
  console.log(
    `[judge] ${prediction.id} correct=${judgement.correct} faithful=${judgement.faithful}`,
  )
})

console.log(`Wrote ${predictions.length} judgements: ${path.relative(REPO_ROOT, outputPath)}`)

function buildJudgePrompt(strategy, question, prediction, citedEvidence) {
  const faithfulnessRule = strategy === 'no_rag'
    ? '- 本回答没有检索证据，因此 faithful 必须输出 null。'
    : '- faithful：回答中的实质事实是否被生成答案所引用的证据支持；不能使用未被引用的模型记忆补足。'
  return [
    '你是独立答案评测员。你没有工具，只能根据给出的材料判断。',
    '只输出一个 JSON 对象，不要输出 Markdown 代码块或额外说明：',
    `{"correct":true|false,"faithful":${strategy === 'no_rag' ? 'null' : 'true|false'},"reason":"不超过80字"}`,
    '',
    '判断标准：',
    '- correct：可回答问题是否抓住了参考答案的关键事实且没有明显错误；不可回答问题是否明确拒答且没有编造事实。',
    faithfulnessRule,
    '- 引用虽有错误但文字没有虚构时，可以 correct=true，但 faithful 必须结合证据严格判断。',
    '',
    `题目类型：${question.type}`,
    `问题：${question.question}`,
    `参考答案：${question.reference_answer}`,
    '',
    `待评回答：${prediction.answer}`,
    `abstained：${prediction.abstained}`,
    '',
    '回答实际引用的证据：',
    citedEvidence || '（无引用证据）',
  ].join('\n')
}

function evidenceForCitations(citations, chunksById) {
  const selected = []
  for (const citation of citations) {
    for (const chunk of chunksById.values()) {
      if (
        chunk.doc_id === citation.doc_id
        && citation.line_start <= chunk.line_end
        && chunk.line_start <= citation.line_end
      ) {
        selected.push(
          `[${chunk.doc_id}#L${chunk.line_start}-L${chunk.line_end}]\n${chunk.text}`,
        )
      }
    }
  }
  return Array.from(new Set(selected)).join('\n\n')
}

function extractFinalText(records) {
  const messages = records
    .map(record => record.event)
    .filter(event => event?.type === 'assistant/message')
    .sort((left, right) => left.seq - right.seq)
  const text = messages
    .flatMap(event => event.data.message.content)
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
  if (!text.trim()) throw new Error('Judge returned no text')
  return text
}

function parseJudgeJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    return JSON.parse(trimmed)
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`Judge output is not JSON: ${trimmed.slice(0, 200)}`)
    return JSON.parse(match[0])
  }
}

async function waitUntilIdle(rpc, sessionId) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const value = await rpc.call('session/wait', {
      sessionId,
      timeoutMs: 60_000,
      afterSeq: 0,
      maxMessages: 20,
    })
    if (value.reason !== 'timeout') return value
  }
  throw new Error(`Judge session ${sessionId} did not become idle`)
}

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
  return {
    async call(method, request) {
      const rpcId = `${method}-${randomUUID()}`
      const response = await fetch(`${baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: cookies },
        body: JSON.stringify({
          type: 'client-request',
          rpcId,
          method,
          payload: { args: { request } },
        }),
      })
      const envelope = await response.json()
      if (!response.ok || !envelope.result?.ok) {
        throw new Error(`${method} failed: ${JSON.stringify(envelope.result?.error)}`)
      }
      return envelope.result.value
    },
  }
}

async function readCompletedIds(filePath) {
  try {
    return new Set((await readFile(filePath, 'utf8'))
      .split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line).id))
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
      '--predictions': 'predictions',
      '--output': 'output',
      '--concurrency': 'concurrency',
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

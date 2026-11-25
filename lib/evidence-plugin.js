/**
 * DSH tool definitions for the evidence agent.
 * @module dsh-evidence-agent/lib/evidence-plugin
 */

import { EvidenceInputError } from './evidence-errors.js'
import {
  DEFAULT_EVIDENCE_CALL_LIMIT,
  EvidenceCallBudget,
} from './evidence-call-budget.js'
import { SEARCH_MODES } from './evidence-query.js'

export const TOOL_NAMES = Object.freeze({
  search: 'dsh-evidence-agent_kb_search',
  read: 'dsh-evidence-agent_kb_read',
  listSources: 'dsh-evidence-agent_kb_list_sources',
})

const SEARCH_HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string', required: true },
    chunk_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    page: { type: 'integer' },
    line_start: { type: 'integer', required: true },
    line_end: { type: 'integer', required: true },
    score: { type: 'number', required: true },
    score_kind: {
      type: 'string',
      enum: ['rrf', 'cosine', 'bm25'],
      required: true,
    },
    text: { type: 'string', required: true },
    source_url: { type: 'string' },
    section: { type: 'string' },
  },
}

const SEARCH_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', required: true },
    mode: { type: 'string', enum: SEARCH_MODES, required: true },
    status: {
      type: 'string',
      enum: ['ok', 'empty', 'degraded', 'unavailable'],
      required: true,
    },
    hits: {
      type: 'array',
      items: SEARCH_HIT_SCHEMA,
      required: true,
    },
    truncated: { type: 'boolean', required: true },
    budget_remaining: { type: 'integer', required: true },
    notice: { type: 'string' },
  },
}

const READ_DOCUMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    source_type: { type: 'string', required: true },
    page_count: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      required: true,
    },
    chunk_count: { type: 'integer', required: true },
    source_url: { type: 'string' },
    license: { type: 'string' },
    updated_at: { type: 'string' },
  },
}

const READ_CHUNK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    chunk_id: { type: 'string', required: true },
    section: { type: 'string', required: true },
    heading_path: {
      type: 'array',
      items: { type: 'string' },
      required: true,
    },
    line_start: { type: 'integer', required: true },
    line_end: { type: 'integer', required: true },
    text: { type: 'string', required: true },
  },
}

const READ_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['ok', 'truncated', 'not_found', 'unavailable'],
      required: true,
    },
    document: READ_DOCUMENT_SCHEMA,
    selected_chunks: {
      type: 'array',
      items: READ_CHUNK_SCHEMA,
      required: true,
    },
    truncated: { type: 'boolean', required: true },
    budget_remaining: { type: 'integer', required: true },
    next_chunk_id: { type: 'string' },
    notice: { type: 'string' },
  },
}

const SOURCE_DOCUMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    doc_id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    source_type: { type: 'string', required: true },
    page_count: {
      oneOf: [{ type: 'integer' }, { type: 'null' }],
      required: true,
    },
    chunk_count: { type: 'integer', required: true },
    updated_at: { type: 'string', required: true },
    source_url: { type: 'string' },
    license: { type: 'string' },
  },
}

const SOURCE_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: {
      type: 'string',
      enum: ['ok', 'empty', 'unavailable'],
      required: true,
    },
    total: { type: 'integer', required: true },
    documents: {
      type: 'array',
      items: SOURCE_DOCUMENT_SCHEMA,
      required: true,
    },
    truncated: { type: 'boolean', required: true },
    budget_remaining: { type: 'integer', required: true },
    notice: { type: 'string' },
  },
}

/**
 * Register the three evidence tools.
 * @param {object} options - registration options.
 * @param {object} options.ctx - Cordis context with `tools`.
 * @param {Function} options.defineTool - DSH defineTool function.
 * @param {Function} options.ToolArgsError - DSH argument error class.
 * @param {object} options.service - evidence service.
 * @param {EvidenceCallBudget} [options.budget] - shared per-turn call budget.
 * @returns {Function[]} registration disposers.
 */
export function registerEvidenceTools({
  ctx,
  defineTool,
  ToolArgsError,
  service,
  budget = new EvidenceCallBudget(),
}) {
  if (typeof defineTool !== 'function') throw new TypeError('defineTool must be a function')
  if (typeof ToolArgsError !== 'function') {
    throw new TypeError('ToolArgsError must be a constructor')
  }
  if (!ctx?.tools || typeof ctx.tools.register !== 'function') {
    throw new TypeError('ctx.tools.register must be available')
  }

  const run = async operation => {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof EvidenceInputError) {
        throw new ToolArgsError(error.issues)
      }
      throw error
    }
  }

  const runBounded = async ({ agentId, operation, denied }) => {
    const decision = budget.consume(agentId)
    if (!decision.allowed) {
      return {
        ...denied(),
        budget_remaining: 0,
        notice: `Evidence tool budget exhausted (${decision.limit} calls per user turn). `
          + 'Stop retrieving and answer from the evidence already returned; '
          + 'if it is insufficient, state that the current knowledge base cannot confirm the answer.',
      }
    }

    const value = await run(operation)
    return {
      ...value,
      budget_remaining: decision.remaining,
    }
  }

  return [
    ctx.tools.register(defineTool({
      name: TOOL_NAMES.search,
      description:
        'Before the first evidence question in a user turn, load the runtime skill '
        + 'dsh-evidence-agent and follow its retrieval policy. Search the local technical knowledge base. Use hybrid retrieval by default '
        + 'for questions about DeepSeek Harness, transformers, BM25, hybrid retrieval, '
        + 'RRF, or retrieval evaluation. Returns bounded evidence chunks with line ranges. '
        + `All three evidence tools share a hard limit of ${budget.maxCalls} calls per user turn.`,
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'A focused Chinese or English search query.',
        },
        top_k: {
          type: 'integer',
          description: 'Maximum hits from 1 to 10; defaults to 5.',
        },
        mode: {
          type: 'string',
          enum: SEARCH_MODES,
          description: 'Retrieval mode; defaults to hybrid.',
        },
      },
      output: {
        schema: SEARCH_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
      },
      timeoutMs: 15_000,
      async execute(args, exec) {
        return runBounded({
          agentId: exec.agent?.id,
          operation: () => service.search({
            query: args.query,
            topK: args.top_k ?? 5,
            mode: args.mode ?? 'hybrid',
            signal: exec.signal,
          }),
          denied: () => ({
            query: args.query,
            mode: args.mode ?? 'hybrid',
            status: 'unavailable',
            hits: [],
            truncated: false,
          }),
        })
      },
    })),
    ctx.tools.register(defineTool({
      name: TOOL_NAMES.read,
      description:
        'Before using evidence tools, load the runtime skill dsh-evidence-agent. '
        + 'Read a specific knowledge-base chunk and its neighbouring chunks. Use this '
        + 'after kb_search when the matching chunk is incomplete or needs more context. '
        + `All three evidence tools share a hard limit of ${budget.maxCalls} calls per user turn.`,
      parameters: {
        doc_id: {
          type: 'string',
          required: true,
          description: 'Document ID returned by kb_search or kb_list_sources.',
        },
        chunk_id: {
          type: 'string',
          required: true,
          description: 'Chunk ID returned by kb_search.',
        },
        neighbor_count: {
          type: 'integer',
          description: 'Neighbours on each side from 0 to 10; defaults to 1.',
        },
      },
      output: {
        schema: READ_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderRead(value) }],
      },
      timeoutMs: 5_000,
      async execute(args, exec) {
        return runBounded({
          agentId: exec.agent?.id,
          operation: () => service.read({
            docId: args.doc_id,
            chunkId: args.chunk_id,
            neighborCount: args.neighbor_count ?? 1,
            signal: exec.signal,
          }),
          denied: () => ({
            status: 'unavailable',
            selected_chunks: [],
            truncated: false,
          }),
        })
      },
    })),
    ctx.tools.register(defineTool({
      name: TOOL_NAMES.listSources,
      description:
        'Before using evidence tools, load the runtime skill dsh-evidence-agent. '
        + 'List documents available in the local evidence knowledge base. Use this when '
        + 'you need to know whether the corpus contains material relevant to a question. '
        + `All three evidence tools share a hard limit of ${budget.maxCalls} calls per user turn.`,
      parameters: {
        limit: {
          type: 'integer',
          description: 'Maximum documents from 1 to 100; defaults to 20.',
        },
      },
      output: {
        schema: SOURCE_OUTPUT_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: renderSourceList(value) }],
      },
      timeoutMs: 5_000,
      async execute(args, exec) {
        return runBounded({
          agentId: exec.agent?.id,
          operation: () => service.listSources({
            limit: args.limit ?? 20,
            signal: exec.signal,
          }),
          denied: () => ({
            status: 'unavailable',
            total: 0,
            documents: [],
            truncated: false,
          }),
        })
      },
    })),
  ]
}

export { DEFAULT_EVIDENCE_CALL_LIMIT }

/**
 * Render a search result for the model.
 * @param {object} value - search result.
 * @returns {string} model-facing text.
 */
export function renderSearch(value) {
  const lines = [
    `Knowledge search: ${value.query}`,
    `mode=${value.mode} status=${value.status} hits=${value.hits.length}`
      + `${value.truncated ? ' truncated=true' : ''}`
      + ` budget_remaining=${value.budget_remaining}`,
  ]
  if (value.notice) lines.push(`notice: ${value.notice}`)

  value.hits.forEach((hit, index) => {
    lines.push(
      '',
      `[${index + 1}] ${hit.doc_id} | ${hit.title}`,
      `${hit.chunk_id} | lines ${hit.line_start}-${hit.line_end} | `
        + `${hit.score_kind}=${formatScore(hit.score)}`
        + `${hit.section ? ` | ${hit.section}` : ''}`,
      hit.text,
    )
    if (hit.source_url) lines.push(`source: ${hit.source_url}`)
  })
  return lines.join('\n')
}

/**
 * Render a contextual read for the model.
 * @param {object} value - read result.
 * @returns {string} model-facing text.
 */
export function renderRead(value) {
  const lines = [
    `Knowledge read: status=${value.status} budget_remaining=${value.budget_remaining}`,
  ]
  if (value.notice) lines.push(`notice: ${value.notice}`)
  if (value.document) {
    lines.push(
      `${value.document.doc_id} | ${value.document.title} | `
        + `${value.document.chunk_count} chunks`,
    )
    if (value.document.source_url) lines.push(`source: ${value.document.source_url}`)
  }
  for (const chunk of value.selected_chunks) {
    lines.push(
      '',
      `${chunk.chunk_id} | lines ${chunk.line_start}-${chunk.line_end} | ${chunk.section}`,
      chunk.text,
    )
  }
  if (value.next_chunk_id) lines.push('', `next_chunk_id: ${value.next_chunk_id}`)
  return lines.join('\n')
}

/**
 * Render a source list for the model.
 * @param {object} value - source-list result.
 * @returns {string} model-facing text.
 */
export function renderSourceList(value) {
  const lines = [
    `Knowledge sources: ${value.documents.length}/${value.total} status=${value.status}`
      + ` budget_remaining=${value.budget_remaining}`,
  ]
  if (value.notice) lines.push(`notice: ${value.notice}`)
  for (const document of value.documents) {
    lines.push(
      `- ${document.doc_id} | ${document.title} | ${document.source_type} | `
        + `${document.chunk_count} chunks | ${document.updated_at}`,
    )
  }
  return lines.join('\n')
}

/**
 * Format a retrieval score consistently.
 * @param {number} score - score.
 * @returns {string} formatted score.
 */
function formatScore(score) {
  return Number.isFinite(score) ? score.toFixed(4) : 'n/a'
}

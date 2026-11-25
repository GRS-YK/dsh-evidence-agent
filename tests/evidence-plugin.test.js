/**
 * Tool-definition tests that do not require the DSH runtime package.
 * @module dsh-evidence-agent/tests/evidence-plugin
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EvidenceInputError } from '../lib/evidence-errors.js'
import { EvidenceCallBudget } from '../lib/evidence-call-budget.js'
import {
  TOOL_NAMES,
  registerEvidenceTools,
  renderRead,
  renderSearch,
  renderSourceList,
} from '../lib/evidence-plugin.js'

function fakeToolRuntime(service, budget) {
  const definitions = []
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        definitions.push(definition)
        const dispose = () => {}
        disposers.push(dispose)
        return dispose
      },
    },
  }
  class ToolArgsError extends Error {
    constructor(issues) {
      super(issues.join('; '))
      this.name = 'ToolArgsError'
      this.issues = issues
    }
  }
  const returnedDisposers = registerEvidenceTools({
    ctx,
    defineTool: definition => definition,
    ToolArgsError,
    service,
    budget,
  })
  return { definitions, returnedDisposers, ToolArgsError }
}

function assertExplicitObjectSchemas(node) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'object') {
    assert.equal(
      node.additionalProperties,
      false,
      'every explicit object schema must set additionalProperties',
    )
  }
  for (const child of Object.values(node.properties ?? {})) {
    assertExplicitObjectSchemas(child)
  }
  assertExplicitObjectSchemas(node.items)
  for (const child of node.oneOf ?? []) assertExplicitObjectSchemas(child)
}

test('plugin registers all three tools with strict schemas', () => {
  const service = {
    async search() {},
    async read() {},
    async listSources() {},
  }
  const { definitions, returnedDisposers } = fakeToolRuntime(service)

  assert.deepEqual(definitions.map(tool => tool.name), [
    TOOL_NAMES.search,
    TOOL_NAMES.read,
    TOOL_NAMES.listSources,
  ])
  assert.equal(returnedDisposers.length, 3)
  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 20)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(definition.output.schema.type, 'object')
    assertExplicitObjectSchemas(definition.output.schema)
  }
})

test('tool executors forward arguments and caller cancellation', async () => {
  const calls = []
  const searchValue = {
    query: 'alpha',
    mode: 'lexical',
    status: 'ok',
    hits: [],
    truncated: false,
  }
  const service = {
    async search(options) {
      calls.push(['search', options])
      return searchValue
    },
    async read(options) {
      calls.push(['read', options])
      return { status: 'ok', selected_chunks: [], truncated: false }
    },
    async listSources(options) {
      calls.push(['list', options])
      return { status: 'ok', total: 0, documents: [], truncated: false }
    },
  }
  const { definitions } = fakeToolRuntime(service)
  const controller = new AbortController()

  assert.deepEqual(
    await definitions[0].execute(
      { query: 'alpha', top_k: 2, mode: 'lexical' },
      { signal: controller.signal, agent: { id: 'session-one' } },
    ),
    { ...searchValue, budget_remaining: 3 },
  )
  await definitions[1].execute(
    { doc_id: 'doc', chunk_id: 'chunk', neighbor_count: 2 },
    { signal: controller.signal, agent: { id: 'session-one' } },
  )
  await definitions[2].execute(
    { limit: 4 },
    { signal: controller.signal, agent: { id: 'session-one' } },
  )

  assert.equal(calls[0][1].signal, controller.signal)
  assert.equal(calls[0][1].topK, 2)
  assert.equal(calls[1][1].neighborCount, 2)
  assert.equal(calls[2][1].limit, 4)
})

test('tool budget rejects a fifth evidence operation without calling the service', async () => {
  let searchCalls = 0
  const service = {
    async search(options) {
      searchCalls += 1
      return {
        query: options.query,
        mode: 'lexical',
        status: 'ok',
        hits: [],
        truncated: false,
      }
    },
    async read() {},
    async listSources() {},
  }
  const budget = new EvidenceCallBudget({ maxCalls: 4 })
  const { definitions } = fakeToolRuntime(service, budget)
  const exec = {
    signal: new AbortController().signal,
    agent: { id: 'session-one' },
  }

  for (let index = 0; index < 4; index += 1) {
    await definitions[0].execute({ query: `query-${index}`, mode: 'lexical' }, exec)
  }
  const denied = await definitions[0].execute({ query: 'query-5', mode: 'lexical' }, exec)

  assert.equal(searchCalls, 4)
  assert.equal(denied.status, 'unavailable')
  assert.equal(denied.budget_remaining, 0)
  assert.match(denied.notice, /budget exhausted/i)
})

test('argument errors become ToolArgsError; cancellation is not swallowed', async () => {
  const inputFailure = new EvidenceInputError(['query is invalid'])
  const cancelReason = new DOMException('cancelled', 'AbortError')
  let mode = 'input'
  const service = {
    async search() {
      if (mode === 'input') throw inputFailure
      throw cancelReason
    },
    async read() {},
    async listSources() {},
  }
  const { definitions, ToolArgsError } = fakeToolRuntime(service)
  const exec = { signal: new AbortController().signal }

  await assert.rejects(
    () => definitions[0].execute({ query: 'alpha' }, exec),
    error => error instanceof ToolArgsError && error.issues[0] === 'query is invalid',
  )
  mode = 'cancel'
  await assert.rejects(
    () => definitions[0].execute({ query: 'alpha' }, exec),
    error => error === cancelReason,
  )
})

test('tool renderers expose citations, context, and source ranges', () => {
  const search = renderSearch({
    query: 'alpha',
    mode: 'hybrid',
    status: 'ok',
    hits: [{
      doc_id: 'doc-one',
      chunk_id: 'doc-one-c001',
      title: 'Document One',
      line_start: 10,
      line_end: 20,
      score: 0.03,
      score_kind: 'rrf',
      text: 'Evidence text.',
      source_url: 'https://example.test/source',
      section: 'Search',
    }],
    truncated: false,
    budget_remaining: 3,
  })
  assert.match(search, /doc-one/)
  assert.match(search, /lines 10-20/)
  assert.match(search, /budget_remaining=3/)

  const read = renderRead({
    status: 'truncated',
    document: {
      doc_id: 'doc-one',
      title: 'Document One',
      chunk_count: 3,
    },
    selected_chunks: [{
      chunk_id: 'doc-one-c002',
      section: 'Search',
      line_start: 21,
      line_end: 30,
      text: 'More evidence.',
    }],
    truncated: true,
    budget_remaining: 2,
    next_chunk_id: 'doc-one-c003',
  })
  assert.match(read, /next_chunk_id: doc-one-c003/)
  assert.match(read, /More evidence/)
  assert.match(read, /budget_remaining=2/)

  const list = renderSourceList({
    status: 'ok',
    total: 1,
    documents: [{
      doc_id: 'doc-one',
      title: 'Document One',
      source_type: 'Markdown',
      chunk_count: 3,
      updated_at: '2026-11-25',
    }],
    truncated: false,
    budget_remaining: 1,
  })
  assert.match(list, /doc-one/)
  assert.match(list, /3 chunks/)
  assert.match(list, /budget_remaining=1/)
})

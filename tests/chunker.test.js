/**
 * Structural behavior tests for the Markdown chunker.
 * @module dsh-evidence-agent/tests/chunker
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkMarkdown, estimateTokens } from '../lib/chunker.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('empty Markdown produces no chunks', () => {
  assert.deepEqual(chunkMarkdown(' \n\n', { docId: 'empty-doc' }), [])
})

test('headings define sections and preserve one-based line ranges', () => {
  const markdown = [
    '# Guide',
    '',
    'Intro.',
    '',
    '## Install',
    '',
    'Run npm test.',
    '',
    '## Search',
    '',
    'Enter a query.',
  ].join('\n')

  const chunks = chunkMarkdown(markdown, { docId: 'guide' })
  assert.equal(chunks.length, 3)
  assert.deepEqual(chunks.map(chunk => chunk.section), ['Guide', 'Install', 'Search'])
  assert.deepEqual(
    chunks.map(chunk => [chunk.line_start, chunk.line_end]),
    [[1, 3], [5, 7], [9, 11]],
  )
  assert.deepEqual(chunks.map(chunk => chunk.chunk_id), [
    'guide-c001',
    'guide-c002',
    'guide-c003',
  ])
})

test('nested headings preserve their full hierarchy', () => {
  const markdown = [
    '# Root',
    '',
    'Root introduction.',
    '',
    '## Alpha',
    '',
    'Alpha body.',
    '',
    '### Details',
    '',
    'Detail body.',
    '',
    '## Beta',
    '',
    'Beta body.',
  ].join('\n')

  const chunks = chunkMarkdown(markdown, { docId: 'nested-doc' })
  assert.deepEqual(chunks.map(chunk => chunk.heading_path), [
    ['Root'],
    ['Root', 'Alpha'],
    ['Root', 'Alpha', 'Details'],
    ['Root', 'Beta'],
  ])
  assert.deepEqual(
    chunks.map(chunk => [chunk.line_start, chunk.line_end]),
    [[1, 3], [5, 7], [9, 11], [13, 15]],
  )
})

test('long sections split and retain a bounded overlap', () => {
  const first = 'alpha '.repeat(24) + 'FIRST-END'
  const second = 'beta '.repeat(24) + 'SECOND-END'
  const markdown = `# Long\n\n${first}\n\n${second}`
  const chunks = chunkMarkdown(markdown, {
    docId: 'long-doc',
    maxTokens: 50,
    overlapTokens: 12,
  })

  assert.ok(chunks.length >= 2)
  assert.match(chunks[0].text, /FIRST-END/)
  assert.match(chunks[1].text, /FIRST-END/)
  assert.match(chunks[1].text, /SECOND-END/)
  assert.equal(chunks[1].section, 'Long')
  assert.equal(chunks[1].line_start <= 4, true)

  const secondBody = chunks[1].text.slice('# Long\n\n'.length)
  const secondStart = secondBody.indexOf(second)
  const overlap = secondBody.slice(0, secondStart).trim()
  assert.ok(overlap.length > 0)
  assert.ok(estimateTokens(overlap) <= 12)
})

test('zero overlap and repeated runs are deterministic', () => {
  const markdown = `# Long\n\n${'alpha '.repeat(30)}FIRST-END\n\n${'beta '.repeat(30)}SECOND-END`
  const options = {
    docId: 'deterministic-doc',
    maxTokens: 50,
    overlapTokens: 0,
  }
  const firstRun = chunkMarkdown(markdown, options)
  const secondRun = chunkMarkdown(markdown, options)

  assert.deepEqual(secondRun, firstRun)
  assert.ok(firstRun.length >= 2)
  assert.doesNotMatch(firstRun[1].text, /FIRST-END/)
  assert.deepEqual(
    firstRun.map(chunk => chunk.chunk_id),
    firstRun.map((_, index) => `deterministic-doc-c${String(index + 1).padStart(3, '0')}`),
  )
})

test('headings inside fenced code blocks stay in the same section', () => {
  const markdown = [
    '# Plugin',
    '',
    '```markdown',
    '# This is sample text, not a heading',
    '```',
    '',
    '中文内容也应正常切分。',
  ].join('\n')
  const chunks = chunkMarkdown(markdown, { docId: 'plugin-doc' })

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].section, 'Plugin')
  assert.match(chunks[0].text, /This is sample text/)
  assert.ok(estimateTokens('中文测试') > 0)
})

test('front matter, comments, and setext headings are handled structurally', () => {
  const markdown = [
    '---',
    'title: Metadata only',
    '---',
    '',
    '<!-- license notice -->',
    '',
    'Document title',
    '==============',
    '',
    'Body text.',
  ].join('\n')
  const chunks = chunkMarkdown(markdown, { docId: 'setext-doc' })

  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].section, 'Document title')
  assert.deepEqual(chunks[0].heading_path, ['Document title'])
  assert.deepEqual([chunks[0].line_start, chunks[0].line_end], [7, 10])
  assert.doesNotMatch(chunks[0].text, /title: Metadata only/)
  assert.doesNotMatch(chunks[0].text, /license notice/)
})

test('metadata and comment-only input produces no evidence chunks', () => {
  const markdown = [
    '---',
    'title: Metadata only',
    '---',
    '',
    '<!-- no user-visible content -->',
  ].join('\n')
  assert.deepEqual(chunkMarkdown(markdown, { docId: 'metadata-only' }), [])
})

test('CRLF, plain text, and Chinese content remain intact', () => {
  const plain = '第一行中文内容。\r\n第二行没有标题。'
  const plainChunks = chunkMarkdown(plain, {
    docId: 'plain-text',
    title: '纯文本资料',
  })
  assert.equal(plainChunks.length, 1)
  assert.equal(plainChunks[0].section, '纯文本资料')
  assert.deepEqual(plainChunks[0].heading_path, [])
  assert.deepEqual([plainChunks[0].line_start, plainChunks[0].line_end], [1, 2])
  assert.doesNotMatch(plainChunks[0].text, /\r/)
  assert.match(plainChunks[0].text, /第一行中文内容/)

  const chinese = [
    '# 中文文档',
    '',
    '这是第一段中文内容，用于验证字符计数和切分。',
    '',
    '## 检索策略',
    '',
    '向量检索负责语义相似度，BM25 负责关键词匹配。',
  ].join('\r\n')
  const chineseChunks = chunkMarkdown(chinese, { docId: 'chinese-doc' })
  assert.deepEqual(chineseChunks.map(chunk => chunk.section), ['中文文档', '检索策略'])
  assert.match(chineseChunks[1].text, /BM25/)
  assert.ok(chineseChunks.every(chunk => !chunk.text.includes('\r')))
})

test('oversized single lines and multiline blocks never exceed the budget', () => {
  const hugeLine = '中'.repeat(500)
  const manyLines = Array.from(
    { length: 80 },
    (_, index) => `line-${String(index + 1).padStart(2, '0')} retrieval content`,
  ).join('\n')
  const markdown = `# Large\n\n${hugeLine}\n\n${manyLines}\n\nTAIL-MARKER`
  const chunks = chunkMarkdown(markdown, {
    docId: 'large-doc',
    maxTokens: 50,
    overlapTokens: 5,
  })

  assert.ok(chunks.length > 2)
  assert.ok(chunks.every(chunk => chunk.token_count <= 50))
  assert.match(chunks.at(-1).text, /TAIL-MARKER/)
  assert.equal(new Set(chunks.map(chunk => chunk.chunk_id)).size, chunks.length)
})

test('all canonical documents produce valid bounded chunks', async () => {
  const metadata = (await readFile(
    path.join(REPO_ROOT, 'knowledge', 'manifest.jsonl'),
    'utf8',
  )).trim().split('\n').map(line => JSON.parse(line))
  const allChunks = []

  for (const document of metadata) {
    const markdown = await readFile(path.join(REPO_ROOT, document.canonical_path), 'utf8')
    const lineCount = markdown.replace(/\r\n?/g, '\n').split('\n').length
    const chunks = chunkMarkdown(markdown, {
      docId: document.doc_id,
      title: document.title,
    })

    assert.ok(chunks.length > 0, `${document.doc_id} should produce chunks`)
    for (const chunk of chunks) {
      assert.ok(chunk.token_count <= 600, `${chunk.chunk_id} exceeds 600 tokens`)
      assert.ok(chunk.line_start >= 1)
      assert.ok(chunk.line_end <= lineCount)
      assert.ok(chunk.line_start <= chunk.line_end)
      assert.ok(chunk.heading_path.length > 0)
      assert.ok(chunk.text.length > 0)
    }
    allChunks.push(...chunks)
  }

  assert.equal(new Set(allChunks.map(chunk => chunk.chunk_id)).size, allChunks.length)
})

test('invalid chunk limits fail with a useful error', () => {
  assert.throws(() => estimateTokens(null), /text must be a string/)
  assert.throws(() => chunkMarkdown(null, { docId: 'x' }), /markdown must be a string/)
  assert.throws(() => chunkMarkdown('# x', { docId: 'Bad_ID' }), /docId/)
  assert.throws(
    () => chunkMarkdown('# x', { docId: 'x', title: 42 }),
    /title must be a string/,
  )
  assert.throws(
    () => chunkMarkdown('# x', { docId: 'x', maxTokens: 20 }),
    /maxTokens/,
  )
  assert.throws(
    () => chunkMarkdown('# x', { docId: 'x', maxTokens: 50.5 }),
    /maxTokens/,
  )
  assert.throws(
    () => chunkMarkdown('# x', { docId: 'x', maxTokens: 100, overlapTokens: 100 }),
    /overlapTokens/,
  )
  assert.throws(
    () => chunkMarkdown('# x', { docId: 'x', overlapTokens: -1 }),
    /overlapTokens/,
  )
})

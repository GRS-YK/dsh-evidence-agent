/**
 * Tests for deterministic knowledge manifest generation.
 * @module dsh-evidence-agent/tests/knowledge-manifest
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildKnowledgeManifest,
  serializeManifest,
  sha256,
} from '../lib/knowledge-manifest.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('sha256 returns the standard lowercase digest', () => {
  assert.equal(
    sha256('hello'),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  )
})

test('buildKnowledgeManifest records file metadata and stable JSONL', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-manifest-'))
  t.after(() => rm(tempRoot, { recursive: true, force: true }))

  const canonicalDir = path.join(tempRoot, 'knowledge', 'canonical')
  await mkdir(canonicalDir, { recursive: true })
  await writeFile(path.join(canonicalDir, '01-example.md'), '# Example\n\n正文。\n', 'utf8')

  const catalog = {
    retrieval_date: '2026-11-25',
    documents: [{
      doc_id: 'example-doc',
      title: 'Example',
      file: '01-example.md',
      source_url: 'https://example.com/example.md',
      source_format: 'Markdown',
      license: 'MIT',
    }],
  }

  const records = await buildKnowledgeManifest({ catalog, repoRoot: tempRoot })
  assert.equal(records.length, 1)
  assert.equal(records[0].canonical_path, 'knowledge/canonical/01-example.md')
  assert.equal(records[0].bytes, Buffer.byteLength('# Example\n\n正文。\n'))
  assert.match(records[0].sha256, /^[a-f0-9]{64}$/)
  assert.equal(serializeManifest(records).split('\n').filter(Boolean).length, 1)
})

test('repository catalog covers all eight committed canonical files', async () => {
  const catalog = JSON.parse(
    await readFile(path.join(REPO_ROOT, 'knowledge', 'sources.json'), 'utf8'),
  )
  const manifestText = await readFile(
    path.join(REPO_ROOT, 'knowledge', 'manifest.jsonl'),
    'utf8',
  )
  const records = manifestText.trimEnd().split('\n').map(line => JSON.parse(line))

  assert.equal(records.length, 8)
  assert.deepEqual(records, await buildKnowledgeManifest({ catalog, repoRoot: REPO_ROOT }))
  assert.equal(new Set(records.map(record => record.doc_id)).size, 8)
  assert.equal(new Set(records.map(record => record.sha256)).size, 8)
})

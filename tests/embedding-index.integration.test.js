/**
 * End-to-end test for the embedding index command with a local mock API.
 * @module dsh-evidence-agent/tests/embedding-index.integration
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseVectorIndex } from '../lib/vector-store.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('embedding builder creates and incrementally reuses a JSONL index', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-embedding-'))
  let requestCount = 0

  const server = createServer(async (request, response) => {
    try {
      const requestChunks = []
      for await (const chunk of request) requestChunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(requestChunks).toString('utf8'))

      assert.equal(request.url, '/v1/embeddings')
      assert.equal(request.headers.authorization, 'Bearer test-key')
      assert.equal(payload.model, 'test-embedding')
      assert.ok(Array.isArray(payload.input) && payload.input.length > 0)

      requestCount++
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        model: payload.model,
        data: payload.input.map((_, index) => ({
          index,
          embedding: [0.1 + index, 0.2, 0.3, 0.4],
        })),
      }))
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: String(error) }))
    }
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    await rm(tempRoot, { recursive: true, force: true })
  })

  await mkdir(path.join(tempRoot, 'scripts'), { recursive: true })
  await mkdir(path.join(tempRoot, 'knowledge', 'canonical'), { recursive: true })
  await cp(
    path.join(REPO_ROOT, 'lib'),
    path.join(tempRoot, 'lib'),
    { recursive: true },
  )
  await cp(
    path.join(REPO_ROOT, 'scripts', 'build-embedding-index.js'),
    path.join(tempRoot, 'scripts', 'build-embedding-index.js'),
  )
  await writeFile(
    path.join(tempRoot, 'package.json'),
    JSON.stringify({ type: 'module' }, null, 2) + '\n',
    'utf8',
  )
  await writeFile(
    path.join(tempRoot, 'knowledge', 'canonical', 'example.md'),
    '# Example\n\nIntroduction.\n\n## Install\n\nInstall body.\n',
    'utf8',
  )
  await writeFile(
    path.join(tempRoot, 'knowledge', 'manifest.jsonl'),
    JSON.stringify({
      doc_id: 'example-doc',
      title: 'Example',
      source_url: 'https://example.test/source.md',
      canonical_path: 'knowledge/canonical/example.md',
      license: 'MIT',
    }) + '\n',
    'utf8',
  )

  const address = server.address()
  const environment = {
    ...process.env,
    EMBEDDING_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    EMBEDDING_API_KEY: 'test-key',
    EMBEDDING_MODEL: 'test-embedding',
    EMBEDDING_DIMENSION: '4',
    EMBEDDING_BATCH_SIZE: '10',
    EMBEDDING_TIMEOUT_MS: '5000',
    EMBEDDING_MAX_RETRIES: '0',
  }

  const firstRun = await runBuilder(tempRoot, environment)
  assert.equal(firstRun.code, 0, firstRun.stderr)
  assert.match(firstRun.stdout, /2 chunks, 2 to embed/)
  assert.match(firstRun.stdout, /Wrote knowledge\/index\/vectors\.jsonl/)
  assert.equal(requestCount, 1)

  const indexPath = path.join(tempRoot, 'knowledge', 'index', 'vectors.jsonl')
  const firstIndex = parseVectorIndex(await readFile(indexPath, 'utf8'))
  assert.equal(firstIndex.length, 2)
  assert.equal(firstIndex[0].embedding_dimension, 4)

  requestCount = 0
  const secondRun = await runBuilder(tempRoot, environment)
  assert.equal(secondRun.code, 0, secondRun.stderr)
  assert.match(secondRun.stdout, /2 chunks, 0 to embed/)
  assert.equal(requestCount, 0)
  assert.deepEqual(
    parseVectorIndex(await readFile(indexPath, 'utf8')),
    firstIndex,
  )
})

/**
 * Run the real builder command in a child process.
 * @param {string} cwd - temporary repository root.
 * @param {NodeJS.ProcessEnv} env - process environment.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>} result.
 */
function runBuilder(cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/build-embedding-index.js'], {
      cwd,
      env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
  })
}

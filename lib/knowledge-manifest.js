/**
 * Build deterministic metadata for the canonical knowledge corpus.
 * @module dsh-evidence-agent/lib/knowledge-manifest
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const DOC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REQUIRED_TEXT_FIELDS = [
  'doc_id',
  'title',
  'file',
  'source_url',
  'source_format',
  'license',
]

/**
 * Compute the lowercase SHA-256 digest of a buffer or string.
 * @param {Buffer|string} content - bytes to hash.
 * @returns {string} hexadecimal SHA-256 digest.
 */
export function sha256(content) {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * Validate one source catalog entry.
 * @param {unknown} entry - entry to validate.
 * @param {number} index - zero-based position in the catalog.
 */
function validateSource(entry, index) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new TypeError(`documents[${index}] must be an object`)
  }

  for (const field of REQUIRED_TEXT_FIELDS) {
    if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
      throw new TypeError(`documents[${index}].${field} must be a non-empty string`)
    }
  }

  if (!DOC_ID_PATTERN.test(entry.doc_id)) {
    throw new TypeError(`documents[${index}].doc_id must use lowercase kebab-case`)
  }
  if (path.basename(entry.file) !== entry.file || path.extname(entry.file) !== '.md') {
    throw new TypeError(`documents[${index}].file must be a Markdown filename`)
  }
}

/**
 * Build manifest objects from a source catalog and canonical Markdown files.
 * @param {object} options - build options.
 * @param {{retrieval_date: string, documents: object[]}} options.catalog - source catalog.
 * @param {string} options.repoRoot - repository root.
 * @returns {Promise<object[]>} manifest records sorted by filename.
 */
export async function buildKnowledgeManifest({ catalog, repoRoot }) {
  if (!catalog || !Array.isArray(catalog.documents)) {
    throw new TypeError('catalog.documents must be an array')
  }
  if (typeof catalog.retrieval_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(catalog.retrieval_date)) {
    throw new TypeError('catalog.retrieval_date must use YYYY-MM-DD')
  }

  catalog.documents.forEach(validateSource)
  const docIds = new Set()
  const files = new Set()

  for (const source of catalog.documents) {
    if (docIds.has(source.doc_id)) {
      throw new Error(`duplicate doc_id: ${source.doc_id}`)
    }
    if (files.has(source.file)) {
      throw new Error(`duplicate file: ${source.file}`)
    }
    docIds.add(source.doc_id)
    files.add(source.file)
  }

  const canonicalDir = path.resolve(repoRoot, 'knowledge', 'canonical')
  const records = []

  for (const source of [...catalog.documents].sort((a, b) => a.file.localeCompare(b.file))) {
    const absolutePath = path.resolve(canonicalDir, source.file)
    const relativePath = path.relative(canonicalDir, absolutePath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error(`canonical file escapes knowledge/canonical: ${source.file}`)
    }

    const [content, fileStats] = await Promise.all([
      readFile(absolutePath),
      stat(absolutePath),
    ])
    if (!fileStats.isFile() || content.length === 0) {
      throw new Error(`canonical file must be non-empty: ${source.file}`)
    }

    const prefix = content.subarray(0, 256).toString('utf8').trimStart().toLowerCase()
    if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) {
      throw new Error(`canonical file contains HTML instead of Markdown: ${source.file}`)
    }

    records.push({
      doc_id: source.doc_id,
      title: source.title,
      source_url: source.source_url,
      source_format: source.source_format,
      license: source.license,
      retrieval_date: catalog.retrieval_date,
      canonical_path: `knowledge/canonical/${source.file}`,
      bytes: content.length,
      sha256: sha256(content),
    })
  }

  return records
}

/**
 * Serialize records as newline-delimited JSON.
 * @param {object[]} records - manifest records.
 * @returns {string} JSONL text ending with a newline.
 */
export function serializeManifest(records) {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}

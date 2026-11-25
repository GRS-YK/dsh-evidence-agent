/**
 * Structure-aware Markdown chunking for the evidence knowledge base.
 * @module dsh-evidence-agent/lib/chunker
 */

const DOC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const WORD_PATTERN = /[A-Za-z0-9_]+/g
const NON_WORD_PATTERN = /[^\sA-Za-z0-9_\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu

/**
 * Estimate language-model tokens without a model-specific tokenizer.
 *
 * CJK characters count as one token each. Latin words and punctuation use
 * conservative multipliers that are stable across platforms.
 * @param {string} text - text to estimate.
 * @returns {number} estimated token count.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string') {
    throw new TypeError('text must be a string')
  }

  const cjkCount = (text.match(CJK_PATTERN) ?? []).length
  const wordCount = (text.match(WORD_PATTERN) ?? []).length
  const punctuationCount = (text.match(NON_WORD_PATTERN) ?? []).length
  return Math.max(1, Math.ceil(cjkCount + wordCount * 1.3 + punctuationCount * 0.25))
}

/**
 * Split Markdown into heading-aware, line-addressable chunks.
 * @param {string} markdown - Markdown source.
 * @param {object} options - chunking options.
 * @param {string} options.docId - stable document ID.
 * @param {string} [options.title] - document title; inferred from the first H1.
 * @param {number} [options.maxTokens=600] - maximum estimated tokens per chunk.
 * @param {number} [options.overlapTokens=80] - maximum estimated overlap tokens.
 * @returns {object[]} deterministic chunks in source order.
 */
export function chunkMarkdown(markdown, options) {
  if (typeof markdown !== 'string') {
    throw new TypeError('markdown must be a string')
  }
  if (!options || typeof options.docId !== 'string' || !DOC_ID_PATTERN.test(options.docId)) {
    throw new TypeError('docId must use lowercase kebab-case')
  }
  if (options.title !== undefined && typeof options.title !== 'string') {
    throw new TypeError('title must be a string when provided')
  }

  const maxTokens = options.maxTokens ?? 600
  const overlapTokens = options.overlapTokens ?? 80
  if (!Number.isInteger(maxTokens) || maxTokens < 50) {
    throw new RangeError('maxTokens must be an integer of at least 50')
  }
  if (!Number.isInteger(overlapTokens) || overlapTokens < 0 || overlapTokens >= maxTokens) {
    throw new RangeError('overlapTokens must be an integer from 0 to maxTokens - 1')
  }
  if (markdown.trim() === '') {
    return []
  }

  const normalized = markdown.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  const blocks = parseBlocks(lines)
  const inferredTitle = blocks.find(block => block.kind === 'heading')?.title ?? options.docId
  const title = options.title?.trim() || inferredTitle
  const sections = groupSections(blocks, title)
  const chunks = []

  for (const section of sections) {
    if (section.blocks.length === 0) continue
    const sectionChunks = chunkSection(section, {
      docId: options.docId,
      title,
      maxTokens,
      overlapTokens,
      ordinal: chunks.length + 1,
    })
    chunks.push(...sectionChunks)
  }

  return chunks
}

/**
 * Parse source lines into atomic Markdown blocks.
 * @param {string[]} lines - normalized source lines.
 * @returns {object[]} atomic blocks.
 */
function parseBlocks(lines) {
  const blocks = []
  let cursor = 0

  while (cursor < lines.length) {
    const line = lines[cursor]
    if (line.trim() === '') {
      cursor++
      continue
    }

    if (cursor === 0 && line.trim() === '---') {
      const closing = lines.findIndex((candidate, index) => (
        index > 0 && candidate.trim() === '---'
      ))
      if (closing > 0) {
        blocks.push(makeBlock('frontmatter', lines, 0, closing))
        cursor = closing + 1
        continue
      }
    }

    const fence = line.match(FENCE_PATTERN)?.[1]
    if (fence) {
      const marker = fence[0]
      const minimumLength = fence.length
      let end = cursor + 1
      while (end < lines.length) {
        const close = lines[end].match(FENCE_PATTERN)?.[1]
        if (close && close[0] === marker && close.length >= minimumLength) break
        end++
      }
      end = Math.min(end, lines.length - 1)
      blocks.push(makeBlock('code', lines, cursor, end))
      cursor = end + 1
      continue
    }

    if (line.trimStart().startsWith('<!--')) {
      let end = cursor
      while (end < lines.length && !lines[end].includes('-->')) end++
      end = Math.min(end, lines.length - 1)
      blocks.push(makeBlock('comment', lines, cursor, end))
      cursor = end + 1
      continue
    }

    const heading = line.match(HEADING_PATTERN)
    if (heading) {
      blocks.push({
        kind: 'heading',
        level: heading[1].length,
        title: heading[2].trim(),
        text: line,
        line_start: cursor + 1,
        line_end: cursor + 1,
        token_count: estimateTokens(line),
      })
      cursor++
      continue
    }

    const setext = lines[cursor + 1]?.match(/^ {0,3}(=+|-+)\s*$/)
    if (setext) {
      const text = `${line}\n${lines[cursor + 1]}`
      blocks.push({
        kind: 'heading',
        level: setext[1][0] === '=' ? 1 : 2,
        title: line.trim(),
        text,
        line_start: cursor + 1,
        line_end: cursor + 2,
        token_count: estimateTokens(text),
      })
      cursor += 2
      continue
    }

    const start = cursor
    cursor++
    while (cursor < lines.length) {
      const candidate = lines[cursor]
      if (
        candidate.trim() === ''
        || HEADING_PATTERN.test(candidate)
        || FENCE_PATTERN.test(candidate)
        || candidate.trimStart().startsWith('<!--')
      ) {
        break
      }
      cursor++
    }
    blocks.push(makeBlock('paragraph', lines, start, cursor - 1))
  }

  return blocks
}

/**
 * Build a block from an inclusive source line range.
 * @param {string} kind - block type.
 * @param {string[]} lines - source lines.
 * @param {number} start - zero-based inclusive start.
 * @param {number} end - zero-based inclusive end.
 * @returns {object} parsed block.
 */
function makeBlock(kind, lines, start, end) {
  const text = lines.slice(start, end + 1).join('\n')
  return {
    kind,
    text,
    line_start: start + 1,
    line_end: end + 1,
    token_count: estimateTokens(text),
  }
}

/**
 * Group blocks under their heading hierarchy.
 * @param {object[]} blocks - parsed Markdown blocks.
 * @param {string} documentTitle - title used for preamble content.
 * @returns {{title: string, headingPath: string[], blocks: object[]}[]} sections.
 */
function groupSections(blocks, documentTitle) {
  const sections = []
  const headingStack = []
  let current = { title: documentTitle, headingPath: [], blocks: [] }

  for (const block of blocks) {
    if (block.kind === 'frontmatter' || block.kind === 'comment') {
      continue
    }
    if (block.kind !== 'heading') {
      current.blocks.push(block)
      continue
    }

    if (current.blocks.length > 0) {
      sections.push(current)
    }
    headingStack.length = block.level - 1
    headingStack[block.level - 1] = block.title
    current = {
      title: block.title,
      headingPath: headingStack.filter(Boolean),
      blocks: [block],
    }
  }

  if (current.blocks.length > 0) {
    sections.push(current)
  }
  return sections
}

/**
 * Split and pack one heading section into token-bounded chunks.
 * @param {{title: string, headingPath: string[], blocks: object[]}} section - section.
 * @param {object} options - chunking context.
 * @returns {object[]} section chunks.
 */
function chunkSection(section, options) {
  const heading = section.blocks[0]?.kind === 'heading' ? section.blocks[0] : null
  const headingTokens = heading?.token_count ?? 0
  const bodyBudget = Math.max(1, options.maxTokens - headingTokens)
  const body = section.blocks
    .filter(block => block !== heading)
    .flatMap(block => splitOversizedBlock(block, bodyBudget))

  if (body.length === 0) {
    return [buildChunk({
      section,
      heading,
      bodyBlocks: [],
      overlapBlock: null,
      options,
      ordinal: options.ordinal,
      isFirstInSection: true,
    })]
  }

  const chunks = []
  let cursor = 0
  let overlapBlock = null

  while (cursor < body.length) {
    let bodyTokens = 0
    if (overlapBlock) {
      const available = options.maxTokens - headingTokens - body[cursor].token_count
      overlapBlock = limitOverlapBlock(overlapBlock, Math.min(options.overlapTokens, available))
      if (overlapBlock) bodyTokens += overlapBlock.token_count
    }

    const selected = []
    while (cursor < body.length) {
      const block = body[cursor]
      if (headingTokens + bodyTokens + block.token_count > options.maxTokens) break
      selected.push(block)
      bodyTokens += block.token_count
      cursor++
    }

    if (selected.length === 0) {
      selected.push(body[cursor])
      cursor++
    }

    chunks.push(buildChunk({
      section,
      heading,
      bodyBlocks: selected,
      overlapBlock,
      options,
      ordinal: options.ordinal + chunks.length,
      isFirstInSection: chunks.length === 0,
    }))
    overlapBlock = makeOverlapBlock(selected.at(-1), options.overlapTokens)
  }

  return chunks
}

/**
 * Build one public chunk record.
 * @param {object} input - chunk construction input.
 * @returns {object} public chunk.
 */
function buildChunk({
  section,
  heading,
  bodyBlocks,
  overlapBlock,
  options,
  ordinal,
  isFirstInSection,
}) {
  const body = overlapBlock ? [overlapBlock, ...bodyBlocks] : bodyBlocks
  const textParts = [heading?.text, ...body.map(block => block.text)].filter(Boolean)
  const text = textParts.join('\n\n')
  const bodyStart = body[0]?.line_start
  const lineStart = isFirstInSection && heading
    ? heading.line_start
    : bodyStart ?? heading?.line_start
  const lineEnd = body.at(-1)?.line_end ?? heading?.line_end

  return {
    doc_id: options.docId,
    chunk_id: `${options.docId}-c${String(ordinal).padStart(3, '0')}`,
    document_title: options.title,
    section: section.title,
    heading_path: section.headingPath,
    section_line: heading?.line_start ?? null,
    line_start: lineStart,
    line_end: lineEnd,
    token_count: estimateTokens(text),
    char_count: Array.from(text).length,
    text,
  }
}

/**
 * Split a block that is too large for one chunk.
 * @param {object} block - parsed block.
 * @param {number} maxTokens - body budget.
 * @returns {object[]} fitting blocks in source order.
 */
function splitOversizedBlock(block, maxTokens) {
  if (block.token_count <= maxTokens) return [block]

  const lines = block.text.split('\n')
  const atoms = lines.flatMap((line, index) => {
    const lineNumber = block.line_start + index
    if (estimateTokens(line) > maxTokens) {
      return splitLongLine(line, lineNumber, maxTokens, block.kind)
    }
    return [makePiece([line], lineNumber, block.kind)]
  })

  const pieces = []
  let current = []
  for (const atom of atoms) {
    const candidateText = [...current, atom].map(piece => piece.text).join('\n')
    if (current.length > 0 && estimateTokens(candidateText) > maxTokens) {
      pieces.push(combinePieces(current, block.kind))
      current = []
    }
    current.push(atom)
  }
  if (current.length > 0) {
    pieces.push(combinePieces(current, block.kind))
  }
  return pieces
}

/**
 * Split a single oversized source line while retaining its line number.
 * @param {string} text - source line.
 * @param {number} lineNumber - one-based source line.
 * @param {number} maxTokens - body budget.
 * @param {string} kind - source block kind.
 * @returns {object[]} fitting pieces.
 */
function splitLongLine(text, lineNumber, maxTokens, kind) {
  const pieces = []
  let remaining = text

  while (remaining && estimateTokens(remaining) > maxTokens) {
    const totalTokens = estimateTokens(remaining)
    const approximateLength = Math.max(
      1,
      Math.floor(remaining.length * maxTokens / totalTokens * 0.9),
    )
    const window = remaining.slice(0, approximateLength)
    const sentenceEnd = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？'),
      window.lastIndexOf('. '),
      window.lastIndexOf('; '),
    )
    const cut = sentenceEnd >= Math.floor(approximateLength / 2)
      ? sentenceEnd + 1
      : approximateLength
    pieces.push(makePiece([remaining.slice(0, cut)], lineNumber, kind))
    remaining = remaining.slice(cut)
  }

  if (remaining) pieces.push(makePiece([remaining], lineNumber, kind))
  return pieces
}

/**
 * Build a split block piece.
 * @param {string[]} lines - piece lines.
 * @param {number} startLine - one-based start line.
 * @param {string} kind - source block kind.
 * @returns {object} block piece.
 */
function makePiece(lines, startLine, kind) {
  const text = lines.join('\n')
  return {
    kind,
    text,
    line_start: startLine,
    line_end: startLine + lines.length - 1,
    token_count: estimateTokens(text),
  }
}

/**
 * Join adjacent split pieces into one source block.
 * @param {object[]} pieces - adjacent block pieces.
 * @param {string} kind - source block kind.
 * @returns {object} combined block.
 */
function combinePieces(pieces, kind) {
  const text = pieces.map(piece => piece.text).join('\n')
  return {
    kind,
    text,
    line_start: pieces[0].line_start,
    line_end: pieces.at(-1).line_end,
    token_count: estimateTokens(text),
  }
}

/**
 * Produce a bounded tail from a source block for the next chunk.
 * @param {object|undefined} block - previous chunk's final block.
 * @param {number} maxTokens - maximum overlap budget.
 * @returns {object|null} overlap block.
 */
function makeOverlapBlock(block, maxTokens) {
  if (!block || maxTokens <= 0) return null
  return limitOverlapBlock(block, maxTokens)
}

/**
 * Limit a source block to an overlap token budget.
 * @param {object} block - source block.
 * @param {number} maxTokens - available overlap budget.
 * @returns {object|null} full or partial block.
 */
function limitOverlapBlock(block, maxTokens) {
  if (!block || maxTokens <= 0) return null
  if (block.token_count <= maxTokens) return block

  const approximateLength = Math.max(
    1,
    Math.floor(block.text.length * maxTokens / block.token_count),
  )
  const text = block.text.slice(-approximateLength)
  return {
    kind: block.kind,
    text,
    line_start: block.line_start,
    line_end: block.line_end,
    token_count: estimateTokens(text),
  }
}

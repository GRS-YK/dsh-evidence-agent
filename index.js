/**
 * dsh-evidence-agent — source-backed Agentic RAG for DeepSeek Harness.
 *
 * Skeleton follows the official tool tutorial plus a runtime skill. The
 * bundled SKILL.md teaches the agent when and how to use the tool.
 *
 * @module dsh-evidence-agent
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { registerEvidenceTools } from './lib/evidence-plugin.js'
import { EvidenceService } from './lib/evidence-service.js'

export const name = 'dsh-evidence-agent'

export const inject = ['tools']

const SKILL_FILE = fileURLToPath(new URL('./skills/dsh-evidence-agent/SKILL.md', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url))

/**
 * Register evidence tools and the companion research skill.
 * @param {import('@deepseek-ai/cordis').Context} ctx - cordis context.
 * @param {object} [config] - optional plugin config from cordis.patch.yml.
 */
export function apply(ctx, config) {
  const disposers = []

  const skills = ctx.get('skills')
  if (skills && typeof skills.register === 'function') {
    try {
      disposers.push(skills.register({
        name: 'dsh-evidence-agent',
        description: 'Search and read source-backed evidence from the project knowledge base.',
        content: readFileSync(SKILL_FILE, 'utf8'),
        source: 'runtime',
        provider: 'dsh-evidence-agent',
      }))
    } catch (error) {
      ctx.logger?.warn?.('dsh-evidence-agent: failed to register skill: ' + String(error))
    }
  }

  const service = new EvidenceService({
    repoRoot: REPO_ROOT,
    searchTimeoutMs: config?.searchTimeoutMs,
    readTimeoutMs: config?.readTimeoutMs,
  })
  disposers.push(...registerEvidenceTools({
    ctx,
    defineTool,
    ToolArgsError,
    service,
  }))

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // disposal failures must not break unload
      }
    }
  }
}

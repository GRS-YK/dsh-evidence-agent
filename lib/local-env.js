/**
 * Minimal local .env loader for command-line entry points.
 * @module dsh-evidence-agent/lib/local-env
 */

import { existsSync, readFileSync } from 'node:fs'

/**
 * Load simple KEY=VALUE entries without adding a runtime dependency.
 * Existing process environment variables take precedence.
 * @param {string} filePath - local .env path.
 */
export function loadLocalEnv(filePath) {
  if (!existsSync(filePath)) return

  for (const rawLine of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) continue
    const [, key, rawValue] = match
    if (process.env[key] !== undefined) continue
    let value = rawValue.trim()
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

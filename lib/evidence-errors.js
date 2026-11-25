/**
 * Stable errors shared by evidence tools and their service layer.
 * @module dsh-evidence-agent/lib/evidence-errors
 */

/**
 * Invalid tool or service arguments.
 */
export class EvidenceInputError extends TypeError {
  /**
   * @param {string|string[]} issues - one or more validation failures.
   */
  constructor(issues) {
    const normalized = Array.isArray(issues) ? issues : [issues]
    super(normalized.join('; '))
    this.name = 'EvidenceInputError'
    this.code = 'INVALID_ARGUMENT'
    this.issues = normalized
  }
}

/**
 * A recoverable missing or unusable evidence resource.
 */
export class EvidenceUnavailableError extends Error {
  /**
   * @param {string} message - actionable diagnostic.
   * @param {string} code - stable reason code.
   * @param {object} [options] - standard error options.
   */
  constructor(message, code = 'EVIDENCE_UNAVAILABLE', options = {}) {
    super(message, options)
    this.name = 'EvidenceUnavailableError'
    this.code = code
  }
}

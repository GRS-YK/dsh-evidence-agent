/**
 * Per-turn budget shared by all evidence tools.
 * @module dsh-evidence-agent/lib/evidence-call-budget
 */

export const DEFAULT_EVIDENCE_CALL_LIMIT = 4

export class EvidenceCallBudget {
  /**
   * @param {object} [options] - budget options.
   * @param {number} [options.maxCalls=4] - allowed tool calls per user turn.
   * @param {Function} [options.now] - injectable clock.
   * @param {number} [options.idleResetMs=1800000] - fallback reset for hosts
   *   that cannot report turn boundaries.
   */
  constructor({
    maxCalls = DEFAULT_EVIDENCE_CALL_LIMIT,
    now = Date.now,
    idleResetMs = 30 * 60 * 1000,
  } = {}) {
    if (!Number.isInteger(maxCalls) || maxCalls < 1) {
      throw new RangeError('maxCalls must be a positive integer')
    }
    if (!Number.isInteger(idleResetMs) || idleResetMs < 1) {
      throw new RangeError('idleResetMs must be a positive integer')
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function')

    this.maxCalls = maxCalls
    this.now = now
    this.idleResetMs = idleResetMs
    this.sessions = new Map()
  }

  /**
   * Reset the counter when DSH starts a new user turn.
   * @param {string} sessionId - Agent/session identity.
   */
  beginTurn(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return
    this.sessions.set(sessionId, {
      used: 0,
      lastUsedAt: this.now(),
    })
  }

  /**
   * Claim one evidence tool call.
   * @param {string} sessionId - Agent/session identity.
   * @returns {{allowed: boolean, used: number, remaining: number, limit: number}}
   *   budget decision.
   */
  consume(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') {
      return {
        allowed: true,
        used: 0,
        remaining: this.maxCalls,
        limit: this.maxCalls,
      }
    }

    const timestamp = this.now()
    let state = this.sessions.get(sessionId)
    if (!state || timestamp - state.lastUsedAt >= this.idleResetMs) {
      state = { used: 0, lastUsedAt: timestamp }
      this.sessions.set(sessionId, state)
    }

    if (state.used >= this.maxCalls) {
      return {
        allowed: false,
        used: state.used,
        remaining: 0,
        limit: this.maxCalls,
      }
    }

    state.used += 1
    state.lastUsedAt = timestamp
    return {
      allowed: true,
      used: state.used,
      remaining: this.maxCalls - state.used,
      limit: this.maxCalls,
    }
  }
}

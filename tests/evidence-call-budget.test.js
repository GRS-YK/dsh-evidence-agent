/**
 * Tests for the hard per-turn evidence tool budget.
 * @module dsh-evidence-agent/tests/evidence-call-budget
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EvidenceCallBudget } from '../lib/evidence-call-budget.js'

test('evidence budget allows four calls and rejects the fifth', () => {
  const budget = new EvidenceCallBudget()

  assert.deepEqual(
    Array.from({ length: 4 }, () => budget.consume('session-one').remaining),
    [3, 2, 1, 0],
  )
  assert.deepEqual(budget.consume('session-one'), {
    allowed: false,
    used: 4,
    remaining: 0,
    limit: 4,
  })
})

test('evidence budget resets on a new turn and stays isolated by session', () => {
  const budget = new EvidenceCallBudget()
  budget.consume('session-one')
  budget.consume('session-one')
  assert.equal(budget.consume('session-two').remaining, 3)

  budget.beginTurn('session-one')
  assert.equal(budget.consume('session-one').remaining, 3)
})

test('evidence budget supports a configured hard limit', () => {
  const budget = new EvidenceCallBudget({ maxCalls: 2 })
  assert.equal(budget.consume('session-one').allowed, true)
  assert.equal(budget.consume('session-one').allowed, true)
  assert.equal(budget.consume('session-one').allowed, false)
})

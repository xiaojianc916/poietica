import { describe, expect, it } from 'bun:test'

import {
  APPLICATION_FAILURE_CODES,
  APPLICATION_FAILURE_POLICIES,
  DEGRADABLE_FEATURE_IDS,
} from './application-policy'

/**
 * The declared set of degradable features and the policies that degrade them
 * are two halves of one statement, and they drift apart silently: a policy
 * pointing at an undeclared feature disables a control nothing will ever
 * restore, and a declared feature nothing degrades is a promise about a
 * behaviour that does not exist.
 */

const degradableCodes = APPLICATION_FAILURE_CODES.filter(
  (code) => APPLICATION_FAILURE_POLICIES[code].recovery === 'disable-feature',
)

const usedFeatureIds = new Set(
  degradableCodes.flatMap((code) => {
    const scope = APPLICATION_FAILURE_POLICIES[code].scope({})
    return scope.kind === 'feature' ? [scope.featureId] : []
  }),
)

describe('Git branch operation failures', () => {
  it('remain retryable without degrading the Git feature', () => {
    const policy = APPLICATION_FAILURE_POLICIES.GIT_BRANCH_OPERATION_FAILED

    expect(policy.impact).toBe('recoverable')
    expect(policy.recovery).toBe('retry')
    expect(policy.scope({})).toEqual({
      kind: 'operation',
      operation: 'git-branch-operation',
    })
  })
})

describe('the features this application knows how to lose', () => {
  it('has policies to lose them with', () => {
    expect(degradableCodes.length).toBeGreaterThan(0)
    expect(DEGRADABLE_FEATURE_IDS.length).toBeGreaterThan(0)
  })

  it('degrades nothing it has not declared', () => {
    for (const featureId of usedFeatureIds) {
      expect(DEGRADABLE_FEATURE_IDS).toContain(featureId)
    }
  })

  it('declares nothing it never degrades', () => {
    for (const featureId of DEGRADABLE_FEATURE_IDS) {
      expect([...usedFeatureIds]).toContain(featureId)
    }
  })

  it('gives every disable-feature policy a feature to disable', () => {
    for (const code of degradableCodes) {
      expect(APPLICATION_FAILURE_POLICIES[code].scope({}).kind).toBe('feature')
    }
  })
})

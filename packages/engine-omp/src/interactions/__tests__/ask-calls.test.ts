import { describe, expect, test } from 'bun:test'
import type { Interaction } from '@poietica/engine'
import { AskCallTracker } from '../ask-calls'

/* 题组 ↔ ask 调用号：askDialog 不带号，两边谁先到不确定（Q1-E）。 */

const group = (id: string): Interaction => ({ id, createdAt: 0, timeoutAt: null, kind: 'question', questions: [] })

describe('AskCallTracker', () => {
  test('调用先到：题组发出时直接拿到号，收口也带着它', () => {
    const tracker = new AskCallTracker()
    expect(tracker.started('call-1')).toBeNull()
    expect(tracker.requested(group('g1'))).toBe('call-1')
    expect(tracker.resolved('g1')).toBe('call-1')
    expect(tracker.resolved('g1')).toBeUndefined()
  })

  test('题组先到：先发无号的卡，调用到了交回那一组好补号', () => {
    const tracker = new AskCallTracker()
    const g1 = group('g1')
    expect(tracker.requested(g1)).toBeUndefined()
    expect(tracker.started('call-1')).toBe(g1)
    expect(tracker.resolved('g1')).toBe('call-1')
  })

  test('一轮问两次：按先后各配各的号', () => {
    const tracker = new AskCallTracker()
    tracker.started('call-1')
    expect(tracker.requested(group('g1'))).toBe('call-1')
    tracker.ended('call-1')
    expect(tracker.requested(group('g2'))).toBeUndefined()
    expect(tracker.started('call-2')?.id).toBe('g2')
    expect(tracker.resolved('g1')).toBe('call-1')
    expect(tracker.resolved('g2')).toBe('call-2')
  })

  test('没问人就结束的调用作废，不会被下一组题错认', () => {
    const tracker = new AskCallTracker()
    tracker.started('call-bad')
    tracker.ended('call-bad')
    expect(tracker.requested(group('g1'))).toBeUndefined()
    expect(tracker.started('call-2')?.id).toBe('g1')
  })

  test('只认提问：审批与单问不占 ask 的号', () => {
    const tracker = new AskCallTracker()
    tracker.started('call-1')
    const confirm: Interaction = { id: 'c1', createdAt: 0, timeoutAt: null, kind: 'confirm', title: 't', message: 'm' }
    expect(tracker.requested(confirm)).toBeUndefined()
    expect(tracker.requested(group('g1'))).toBe('call-1')
  })

  test('还没配上号就收口的题组不再等号', () => {
    const tracker = new AskCallTracker()
    tracker.requested(group('g1'))
    expect(tracker.resolved('g1')).toBeUndefined()
    expect(tracker.started('call-1')).toBeNull()
  })
})

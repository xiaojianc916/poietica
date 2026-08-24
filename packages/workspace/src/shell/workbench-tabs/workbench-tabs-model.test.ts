import { describe, expect, it } from 'bun:test'
import type { WorkbenchTabId } from '../../workbench'
import {
  encodeWorkbenchTabDomId,
  resolveWorkbenchTabAutoScrollVelocity,
  resolveWorkbenchTabCloseTarget,
  resolveWorkbenchTabDragLayout,
  resolveWorkbenchTabKeyboardAction,
  type WorkbenchTabModelItem,
  type WorkbenchTabSlot,
} from './workbench-tabs-model'

describe('Workbench Tabs model', () => {
  const tabs: readonly WorkbenchTabModelItem[] = [
    createTab('first', true),

    createTab('second'),

    createTab('fixed', false),
  ]

  const slots: readonly WorkbenchTabSlot[] = [
    slot('first', 0, 100),

    slot('second', 100, 200),

    slot('fixed', 200, 300),
  ]

  it('moves and wraps keyboard navigation', () => {
    expect(resolveWorkbenchTabKeyboardAction(tabs, id('first'), 'ArrowLeft')).toEqual({
      type: 'activate',
      tabId: id('fixed'),
    })

    expect(resolveWorkbenchTabKeyboardAction(tabs, id('fixed'), 'ArrowRight')).toEqual({
      type: 'activate',
      tabId: id('first'),
    })
  })

  it('supports Home and End', () => {
    expect(resolveWorkbenchTabKeyboardAction(tabs, id('second'), 'Home')).toEqual({
      type: 'activate',
      tabId: id('first'),
    })

    expect(resolveWorkbenchTabKeyboardAction(tabs, id('second'), 'End')).toEqual({
      type: 'activate',
      tabId: id('fixed'),
    })
  })

  it('closes only closable tabs', () => {
    expect(resolveWorkbenchTabKeyboardAction(tabs, id('second'), 'Delete')).toEqual({
      type: 'close',
      tabId: id('second'),
    })

    expect(resolveWorkbenchTabKeyboardAction(tabs, id('fixed'), 'Delete')).toBeNull()
  })

  it('prefers the right tab after close', () => {
    expect(resolveWorkbenchTabCloseTarget(tabs, id('first'))).toBe(id('second'))
  })

  it('falls back to the left tab after closing the last tab', () => {
    expect(resolveWorkbenchTabCloseTarget(tabs, id('fixed'))).toBe(id('second'))
  })

  it('returns no close target when the last remaining tab closes', () => {
    expect(resolveWorkbenchTabCloseTarget([createTab('only', true)], id('only'))).toBeNull()
  })

  it('holds every tab in place until the dragged tab clears a neighbour midpoint', () => {
    expect(resolveWorkbenchTabDragLayout(slots, 0, 40)).toEqual({
      index: 0,
      offsets: [40, 0, 0],
    })
  })

  it('slides the passed neighbour into the vacated slot', () => {
    expect(resolveWorkbenchTabDragLayout(slots, 0, 110)).toEqual({
      index: 1,
      offsets: [110, -100, 0],
    })
  })

  it('clamps at the strip end and settles on the last position', () => {
    expect(resolveWorkbenchTabDragLayout(slots, 0, 400)).toEqual({
      index: 2,
      offsets: [200, -100, -100],
    })
  })

  it('clamps at the strip start and settles on the first position', () => {
    expect(resolveWorkbenchTabDragLayout(slots, 2, -400)).toEqual({
      index: 0,
      offsets: [100, 100, -200],
    })
  })

  it.each([-1, 3])('rejects an out-of-range dragged index %s', (fromIndex) => {
    expect(resolveWorkbenchTabDragLayout(slots, fromIndex, 20)).toBeNull()
  })

  it('rejects an empty strip layout', () => {
    expect(resolveWorkbenchTabDragLayout([], 0, 0)).toBeNull()
  })

  it('holds still while the pointer stays away from both edges', () => {
    expect(resolveWorkbenchTabAutoScrollVelocity(0, 300, 150, 48, 720)).toBe(0)
  })

  it('accelerates as the pointer digs into an edge zone', () => {
    expect(resolveWorkbenchTabAutoScrollVelocity(0, 300, 24, 48, 720)).toBe(-360)
  })

  it('caps the speed once the pointer passes the strip edge', () => {
    expect(resolveWorkbenchTabAutoScrollVelocity(0, 300, -100, 48, 720)).toBe(-720)

    expect(resolveWorkbenchTabAutoScrollVelocity(0, 300, 400, 48, 720)).toBe(720)
  })

  it('shrinks the edge zone so a narrow strip rests at its midpoint', () => {
    expect(resolveWorkbenchTabAutoScrollVelocity(0, 60, 30, 48, 720)).toBe(0)
  })

  it('encodes stable DOM identifiers', () => {
    expect(encodeWorkbenchTabDomId('surface:hello/world')).toBe('surface-hello-world')
  })
})

function createTab(value: string, canClose = true): WorkbenchTabModelItem {
  return {
    id: id(value),
    canClose,
  }
}

function slot(value: string, start: number, end: number): WorkbenchTabSlot {
  return {
    id: id(value),
    start,
    end,
  }
}

function id(value: string): WorkbenchTabId {
  return value as WorkbenchTabId
}

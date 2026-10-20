import { describe, expect, test } from 'bun:test'
import { ARCHIVED_FILTER, GROUP_BY, shapeGroups } from '../thread-view'

/*
 * 用户 2026-10-20：还没有对话的项目也要出现在侧栏里，否则既看不见它，
 * 也没有地方删除它。空项目只在「按项目」分组时保留；搜索与单列表照旧不画空组。
 */

const EMPTY_WORKSPACE = { id: 'w-empty', name: '空项目', items: [] }
const USED_WORKSPACE = {
  id: 'w-used',
  name: 'poietica',
  items: [{ title: '你好', updatedAt: '2026-10-20T00:00:00.000Z', archived: false }],
}

describe('项目名单：空项目', () => {
  test('按项目分组时保留没有对话的项目', () => {
    const groups = shapeGroups([USED_WORKSPACE, EMPTY_WORKSPACE], {
      archivedFilter: ARCHIVED_FILTER.hide,
      groupBy: GROUP_BY.workspace,
      query: '',
    })

    expect(groups.map((group) => group.id)).toEqual(['w-used', 'w-empty'])
    expect(groups[1]?.items).toEqual([])
  })

  test('搜索时丢掉没有命中的空项目', () => {
    const groups = shapeGroups([USED_WORKSPACE, EMPTY_WORKSPACE], {
      archivedFilter: ARCHIVED_FILTER.hide,
      groupBy: GROUP_BY.workspace,
      query: '你好',
    })

    expect(groups.map((group) => group.id)).toEqual(['w-used'])
  })

  test('单列表不保留空项目', () => {
    const groups = shapeGroups([USED_WORKSPACE, EMPTY_WORKSPACE], {
      archivedFilter: ARCHIVED_FILTER.hide,
      groupBy: GROUP_BY.flat,
      query: '',
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.id).toBe('__flat__')
  })
})

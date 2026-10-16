import { describe, expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import { act } from 'react'
import type { GithubPullRequest } from '../../contract'
import { PrDetailActions } from '../pr-detail'

/*
 * 冒烟（R-32）：复制回执改用 design-system 的 useCopy 之后，按钮仍长在动作行上、
 * 点一次真的往剪贴板写链接、并给出「已复制」的回执。
 *
 * 这里钉的是**接线**：换实现只允许换掉内部状态机，不允许把动作弄丢。
 */

const PULL: GithubPullRequest = {
  number: 3,
  title: 'x',
  state: 'open',
  draft: false,
  author: 'xiaojianc916',
  avatarUrl: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  mergedAt: null,
  headBranch: 'x',
  baseBranch: 'main',
  mergeStatus: 'clean',
  reviewState: 'none',
  url: 'https://github.com/x/y/pull/3',
  body: '',
  labels: [],
  checks: [],
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  commits: 1,
  comments: 0,
  reviews: 0,
}

function stubClipboard(into: string[]): void {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string): Promise<void> => {
        into.push(text)
        return Promise.resolve()
      },
    },
  })
}

function actions(pull: GithubPullRequest | null): React.ReactElement {
  return (
    <PrDetailActions
      busy={false}
      onMerge={() => undefined}
      onOpenExternal={() => undefined}
      onSendToAgent={() => undefined}
      pull={pull}
    />
  )
}

describe('PrDetailActions 的复制链接', () => {
  test('按钮在、点一下写的是这条 PR 的地址，并给出回执', async () => {
    const written: string[] = []
    stubClipboard(written)

    const view = render(actions(PULL))
    await act(async () => {
      view.getByLabelText('Copy link').click()
    })

    expect(written).toEqual(['https://github.com/x/y/pull/3'])
    /* 回执：成功后标签换成「已复制」那一条（useCopy 切对勾）。 */
    expect(await view.findByLabelText('Link copied')).toBeDefined()
  })

  test('没有 pull 时按钮在、点了不写（判空回到组件里，不再让调用方代办）', async () => {
    const written: string[] = []
    stubClipboard(written)

    const view = render(actions(null))
    await act(async () => {
      view.getByLabelText('Copy link').click()
    })

    expect(written).toEqual([])
  })
})

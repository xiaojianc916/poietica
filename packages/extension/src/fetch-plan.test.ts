import { describe, expect, it } from 'bun:test'

import { DEFAULT_BRANCH_UNPLANNABLE, planFetch } from './fetch-plan'
import { parseInstallSource } from './install-source'

function planOf(specifier: string) {
  return planFetch(parseInstallSource(specifier))
}

describe('planFetch', () => {
  it('本地路径与直链原样交给原生侧', () => {
    expect(planOf('C:\\plugins\\demo')).toEqual({
      kind: 'planned',
      plan: { kind: 'directory', path: 'C:\\plugins\\demo' },
    })
    expect(planOf('https://example.com/demo.zip')).toEqual({
      kind: 'planned',
      plan: { kind: 'archive', url: 'https://example.com/demo.zip', subdirectory: null },
    })
  })

  it('tree 走官方文档的分支归档形式', () => {
    expect(planOf('https://github.com/MoonshotAI/kimi-code/tree/main')).toEqual({
      kind: 'planned',
      plan: {
        kind: 'archive',
        url: 'https://github.com/MoonshotAI/kimi-code/archive/refs/heads/main.zip',
        subdirectory: null,
      },
    })
  })

  it('标签走 refs/tags，斜杠留在路径里', () => {
    expect(planOf('https://github.com/github/codeql-cli/releases/tag/codeql-cli/v2.12.0')).toEqual({
      kind: 'planned',
      plan: {
        kind: 'archive',
        url: 'https://github.com/github/codeql-cli/archive/refs/tags/codeql-cli/v2.12.0.zip',
        subdirectory: null,
      },
    })
  })

  it('提交走裸 sha 形式', () => {
    expect(planOf('https://github.com/MoonshotAI/kimi-code/commit/0fc40c2')).toEqual({
      kind: 'planned',
      plan: {
        kind: 'archive',
        url: 'https://github.com/MoonshotAI/kimi-code/archive/0fc40c2.zip',
        subdirectory: null,
      },
    })
  })

  it('子目录跟着计划一起交给原生侧', () => {
    expect(
      planFetch({
        kind: 'github',
        owner: 'MoonshotAI',
        repo: 'kimi-code',
        ref: { kind: 'tree', ref: 'main' },
        subdirectory: 'plugins/official/kimi-datasource',
      }),
    ).toEqual({
      kind: 'planned',
      plan: {
        kind: 'archive',
        url: 'https://github.com/MoonshotAI/kimi-code/archive/refs/heads/main.zip',
        subdirectory: 'plugins/official/kimi-datasource',
      },
    })
  })

  it('只给仓库地址时说不出该拉哪个 ref', () => {
    expect(planOf('https://github.com/MoonshotAI/kimi-code')).toEqual({
      kind: 'unplannable',
      reason: DEFAULT_BRANCH_UNPLANNABLE,
    })
  })
})

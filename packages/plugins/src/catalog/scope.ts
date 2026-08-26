import { assertUnreachable } from '@poietica/core'

/* 一条名单来自哪里。trust 回答「谁为它背书」，与「谁拥有这条名单」正交。 */

export type CatalogChannel = 'kimi' | 'builtin' | 'personal'

export function describeChannel(channel: CatalogChannel): string {
  switch (channel) {
    case 'kimi':
      return 'Kimi 官方'
    case 'builtin':
      return 'Poietica 精选'
    case 'personal':
      return '个人'
    default:
      return assertUnreachable(channel)
  }
}

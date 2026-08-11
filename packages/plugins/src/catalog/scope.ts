import { assertUnreachable } from '@poietica/core'

/*
 * 一条名单来自哪里，以及卸载之后那张卡片留不留。
 *
 * 这是同一个问题的两面，所以只有一个枚举：名单是公开的，卡片就一直在，卸载只把状态从
 * 「已安装」拨回「可安装」；名单是个人的，那张卡片本身就是用户造出来的，删掉它就该连
 * 卡片一起消失。
 *
 * 用 trust 判这件事是错的：trust 回答「谁为它背书」，与「谁拥有这条名单」正交 —— 一个
 * 第三方插件可以躺在公开名单里，一个用户手填的地址也可以指向官方仓库。
 */

export const CATALOG_CHANNELS = ['kimi', 'builtin', 'personal'] as const

export type CatalogChannel = (typeof CATALOG_CHANNELS)[number]

export type ExtensionScope = 'personal' | 'public'

export function scopeOf(channel: CatalogChannel): ExtensionScope {
  switch (channel) {
    case 'kimi':
    case 'builtin':
      return 'public'
    case 'personal':
      return 'personal'
    default:
      return assertUnreachable(channel)
  }
}

/** 卸载之后这一行还留在名单上吗。界面唯一该问的问题。 */
export function survivesUninstall(channel: CatalogChannel): boolean {
  return scopeOf(channel) === 'public'
}

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

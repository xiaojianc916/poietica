import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { BrowserState, PickedElement } from './entities'
import { browserErrors } from './errors'

export * from './entities'
export { browserErrors } from './errors'

const empty = z.object({})
const host = { owner: 'host' } as const
const tabId = z.object({ tabId: z.number().int().positive() })

/** 07 页 §12B 的方法表 + 05 页 §11.12 的最终形状。全部 owner='host'（没有 core 模块）。 */
export const browserContract = defineContract({
  id: 'browser',
  namespaces: ['browser'],
  methods: [
    defineMethod({
      name: 'browser.state',
      ...host,
      params: empty,
      result: BrowserState,
      description: '读标签面整份快照',
    }),
    defineMethod({
      name: 'browser.newTab',
      ...host,
      params: z.object({ url: z.string().nullable() }),
      result: BrowserState,
      description: '新开一个标签并设为活动（地址归一失败 → browser.invalid_url）',
    }),
    defineMethod({
      name: 'browser.closeTab',
      ...host,
      params: tabId,
      result: BrowserState,
      description: '关掉一个标签（非空白页进最近关闭环）',
    }),
    defineMethod({
      name: 'browser.selectTab',
      ...host,
      params: tabId,
      result: BrowserState,
      description: '切换活动标签',
    }),
    defineMethod({
      name: 'browser.reopenClosed',
      ...host,
      params: z.object({ index: z.number().int().nonnegative() }),
      result: BrowserState,
      description: '重新打开最近关闭环里的一项',
    }),
    defineMethod({
      name: 'browser.navigate',
      ...host,
      params: z.object({ tabId: z.number().int().positive(), url: z.string().min(1) }),
      result: BrowserState,
      description: '在指定标签里导航（地址归一失败 → browser.invalid_url）',
    }),
    defineMethod({
      name: 'browser.back',
      ...host,
      params: tabId,
      result: empty,
      description: '后退',
    }),
    defineMethod({
      name: 'browser.forward',
      ...host,
      params: tabId,
      result: empty,
      description: '前进',
    }),
    defineMethod({
      name: 'browser.reload',
      ...host,
      params: tabId,
      result: empty,
      description: '刷新',
    }),
    defineMethod({
      name: 'browser.stop',
      ...host,
      params: tabId,
      result: empty,
      description: '停止装载',
    }),
    defineMethod({
      name: 'browser.setZoom',
      ...host,
      params: z.object({ tabId: z.number().int().positive(), level: z.number().int().min(-3).max(5) }),
      result: empty,
      description: '设置标签缩放档（0 为默认）',
    }),
    defineMethod({
      name: 'browser.setBounds',
      ...host,
      params: z.object({
        x: z.number(),
        y: z.number(),
        width: z.number(),
        height: z.number(),
      }),
      result: empty,
      description: '面板视口矩形（相对窗口内容区的 CSS 像素）',
    }),
    defineMethod({
      name: 'browser.setVisible',
      ...host,
      params: z.object({ visible: z.boolean() }),
      result: empty,
      description: '显示/隐藏原生视图（有覆盖层时 UI 必须隐藏）',
    }),
    defineMethod({
      name: 'browser.pickElement',
      ...host,
      params: z.object({ tabId: z.number().int().positive(), theme: z.enum(['light', 'dark']) }),
      result: empty,
      description: '在指定标签上开始拾取元素',
    }),
    defineMethod({
      name: 'browser.cancelPick',
      ...host,
      params: empty,
      result: empty,
      description: '取消进行中的拾取',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'browser.stateChanged',
      ...host,
      params: BrowserState,
      description: '标签面变化（16ms 合批）',
    }),
    defineNotification({
      name: 'browser.elementPicked',
      ...host,
      params: PickedElement,
      description: '拾取元素完成（用户点了附加或发送）',
    }),
  ],
  errors: browserErrors,
})

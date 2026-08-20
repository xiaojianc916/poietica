import { createContext, useContext } from 'react'

/*
 * 这条对话对面那家 agent 的方言。
 *
 * 协议规定报文，不规定报文之上的写法：批准按钮上该写什么字，每家不同。这是
 *「值」不是「算法」——通用层对所有 agent 是同一段代码，只是查的表不一样——
 * 所以它由外面交进来，而不是写死在组件里。
 *
 * 为什么是 context 不是 prop：从组合根到用得上它的那两个组件隔着五层，中间三
 * 层跟 agent 方言毫无关系，让它们签收一个自己不看的包裹只会把无关的东西绑在
 * 一起。同一个问题仓里已经有答案（threads-context.ts 的 ThreadsContext），这里
 * 沿用它，不另起一种范式。
 *
 * 没有默认值。给一张兜底的表，等于第二家 agent 悄悄套用第一家的文案：界面照样
 * 画得出来，只是全错，而且不报任何错。缺 provider 就抛，让它在第一次渲染时就
 * 现形。
 *
 * 类型在这里声明，不从 registry 引进来：UI 不该认识名单。registry 的档案在结构
 * 上满足它，两边在组合根那一行由类型系统对账。
 *
 * 这里没有 provider 组件，别处也没有。React 19 起 context 本身就是 provider
 * （<AgentDialectContext value={dialect}>），所以此前那个单独的包装模块 —— 整个
 * 函数体只有一次 context 交接 —— 没有存在的理由，组合根直接写 context。
 *
 * 这个模块因此仍然只导出非组件，那条纪律没有松：context 的身份是模块执行的产物，
 * 混合导出的模块在热更新时会被整个重跑，跑出来的就是另一个 context。
 */

export interface AgentDialect {
  /** 权限选项 name → 显示文案。查不到就照 agent 原文显示。 */
  readonly optionLabels: Readonly<Record<string, string>>
}

export const AgentDialectContext = createContext<AgentDialect | null>(null)

export function useAgentDialect(): AgentDialect {
  const dialect = useContext(AgentDialectContext)

  if (dialect === null) {
    throw new Error('这棵组件树上没有 AgentDialectContext，不知道对面是哪家 agent。')
  }

  return dialect
}

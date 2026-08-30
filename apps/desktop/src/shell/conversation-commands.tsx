import type { CommandRegistry, WorkbenchSessionStore } from '@poietica/workspace'
import { useEffect } from 'react'

import { useThreadsList } from './threads-context'

/*
 * 会话进命令面板。
 *
 * 不另开一条「搜索管线」：面板里的每一行都是一条注册好的命令，会话只是其中
 * 一类贡献者。两条管线意味着两套过滤、两套键盘导航、两套空态，而人按下同一
 * 个键期待的是同一个东西。
 *
 * 渲染无产出，与 AutomationScheduler 同一种形状：它要的是宿主的生命周期，
 * 不是屏幕上的一块地方。挂在 AppShell 之内，而 effect 自下而上兑现，所以它
 * 总是先于 AppShell 自己的 registerApplicationCommands 注册完 ——「聊天」因此
 * 稳定地排在第一组。
 *
 * 次序不在这里排：groupByWorkspace 已经按「组内最近活动」排好，注册表按注册
 * 次序交出快照，面板照着画。三层用的是同一份次序。
 */
interface ConversationCommandsProps {
  readonly registry: CommandRegistry
  readonly workspace: WorkbenchSessionStore
}

export function ConversationCommands({ registry, workspace }: ConversationCommandsProps) {
  const { groups } = useThreadsList()

  useEffect(() => {
    /* 列表变一次就整批换一次；注销按注册的逆序收回。 */
    const dispose = groups.flatMap((group) =>
      group.items.map((item) =>
        registry.register({
          id: `conversation.open:${item.id}`,
          label: item.title,
          category: '聊天',
          /* 目录没被记下来的那一组没有名字，那就不写 —— 不编一个塞进去。 */
          ...(group.name === null ? {} : { detail: group.name }),
          execute: () => {
            workspace.openConversation({ threadId: item.id, title: item.title })
          },
        }),
      ),
    )

    return () => {
      for (let index = dispose.length - 1; index >= 0; index -= 1) {
        dispose[index]?.()
      }
    }
  }, [groups, registry, workspace])

  return null
}

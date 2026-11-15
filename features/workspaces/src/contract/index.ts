import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { Workspace } from './entities'
import { workspacesErrors } from './errors'

export * from './entities'
export { workspacesErrors } from './errors'

const empty = z.object({})

export const workspacesContract = defineContract({
  id: 'workspaces',
  namespaces: ['workspaces'],
  methods: [
    defineMethod({
      name: 'workspaces.list',
      owner: 'core',
      params: empty,
      result: z.object({ workspaces: z.array(Workspace) }),
      description: '列出全部工作区（按最近打开排序）',
    }),
    defineMethod({
      name: 'workspaces.add',
      owner: 'core',
      params: z.object({ path: z.string().min(1) }),
      result: Workspace,
      description: '添加一个文件夹工作区；已存在则返回已有记录并更新最近打开时间',
    }),
    defineMethod({
      name: 'workspaces.createIsolated',
      owner: 'core',
      params: z.object({ sourceWorkspaceId: z.string().min(1), branch: z.string().min(1).optional() }),
      result: Workspace,
      description: '从本地工作区创建一个隔离 worktree 工作区；失败不留下半截记录',
    }),
    defineMethod({
      name: 'workspaces.deliver',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      result: z.union([
        z.object({ applied: z.literal(true) }),
        z.object({ applied: z.literal(false), reason: z.string() }),
      ]),
      description: '把隔离工作区相对基线的补丁应用到主仓库；冲突返回原因，不半写',
    }),
    defineMethod({
      name: 'workspaces.discard',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      result: empty,
      description: '丢弃隔离工作区（删 worktree 与记录）',
    }),
    defineMethod({
      name: 'workspaces.rename',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1), name: z.string() }),
      result: Workspace,
      description: '重命名工作区',
    }),
    defineMethod({
      name: 'workspaces.remove',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      result: empty,
      description: '移除工作区（folder 类型不删除文件夹）',
    }),
    defineMethod({
      name: 'workspaces.touch',
      owner: 'core',
      params: z.object({ workspaceId: z.string().min(1) }),
      result: empty,
      description: '记录最近打开时间（不发通知）',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'workspaces.changed',
      owner: 'core',
      params: z.object({ workspaces: z.array(Workspace) }),
      description: '工作区列表变化',
    }),
  ],
  errors: workspacesErrors,
})

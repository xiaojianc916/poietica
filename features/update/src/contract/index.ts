import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { UpdateState } from './entities'
import { updateErrors } from './errors'

export * from './entities'
export { updateErrors } from './errors'

const empty = z.object({})
const host = { owner: 'host' } as const

/** 应用自动更新（07 页 §15）：检查 → 下载 → 重启并安装，四个方法全在 Host。 */
export const updateContract = defineContract({
  id: 'update',
  namespaces: ['update'],
  methods: [
    defineMethod({
      name: 'update.state',
      ...host,
      params: empty,
      result: UpdateState,
      description: '当前更新状态',
    }),
    defineMethod({
      name: 'update.check',
      ...host,
      params: empty,
      result: UpdateState,
      description: '检查新版本（没有新版本时回到 idle 并记 lastCheckedAt）',
    }),
    defineMethod({
      name: 'update.download',
      ...host,
      params: empty,
      result: UpdateState,
      description: '下载已发现的新版本（仅 available 相位可用）',
    }),
    defineMethod({
      name: 'update.install',
      ...host,
      params: empty,
      result: UpdateState,
      description: '走完整退出流程后重启并安装（仅 ready 相位可用）',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'update.stateChanged',
      owner: 'host',
      params: UpdateState,
      description: '更新状态变化',
    }),
  ],
  errors: updateErrors,
})

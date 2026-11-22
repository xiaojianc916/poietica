import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { PythonStatus } from './entities'
import { pythonErrors } from './errors'

export * from './entities'
export { pythonErrors } from './errors'

const empty = z.object({})

export const pythonContract = defineContract({
  id: 'python',
  namespaces: ['python'],
  methods: [
    defineMethod({
      name: 'python.status',
      owner: 'core',
      params: empty,
      result: PythonStatus,
      description: '查询本机 Python 状态',
    }),
    defineMethod({
      name: 'python.install',
      owner: 'core',
      params: empty,
      result: PythonStatus,
      /* 下载 36 MB 安装包并静默安装：慢网络下 5 分钟不够。互斥在 core 里，重复调用只会拿回当前状态。 */
      timeoutMs: 900_000,
      description: '安装或升级系统 Python（幂等）',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'python.statusChanged',
      owner: 'core',
      params: PythonStatus,
      description: 'Python 状态变化',
    }),
  ],
  errors: pythonErrors,
})

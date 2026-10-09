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
      description: '查询 Python 安装状态',
    }),
    defineMethod({
      name: 'python.install',
      owner: 'core',
      params: empty,
      result: PythonStatus,
      timeoutMs: 300_000,
      description: '安装 Python（幂等）',
    }),
    defineMethod({
      name: 'python.remove',
      owner: 'core',
      params: empty,
      result: empty,
      description: '删除 Python',
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

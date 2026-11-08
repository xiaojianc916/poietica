import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { SecretKey, SecretNamespace, SecretValue } from './entities'
import { secretsErrors } from './errors'

export * from './entities'
export { secretsErrors } from './errors'

/**
 * 凭据库（ADR-008 / 架构设计 §13.4）。Host 用 Electron safeStorage（Windows 上即 DPAPI）加密落盘，
 * 磁盘上不留明文；Core 不持久化凭据，每次启动按命名空间取回、只放在内存里交给引擎。
 *
 * 三个方法都只给 Core 调（callers: ['core']）：渲染进程对它们等同不存在，拿不到任何明文。
 */
export const secretsContract = defineContract({
  id: 'secrets',
  namespaces: ['secrets'],
  methods: [
    defineMethod({
      name: 'secrets.lease',
      owner: 'host',
      callers: ['core'],
      params: z.object({ namespace: SecretNamespace }),
      result: z.object({ entries: z.record(z.string(), z.string()) }),
      description: '取回一个命名空间里的全部密钥（只进调用方内存；解不开的条目跳过并记日志）',
    }),
    defineMethod({
      name: 'secrets.put',
      owner: 'host',
      callers: ['core'],
      params: z.object({ namespace: SecretNamespace, key: SecretKey, value: SecretValue }),
      result: z.object({}),
      description: '加密保存一条密钥；系统加密不可用时报 secrets.unavailable，绝不退回明文',
    }),
    defineMethod({
      name: 'secrets.delete',
      owner: 'host',
      callers: ['core'],
      params: z.object({ namespace: SecretNamespace, key: SecretKey }),
      result: z.object({}),
      description: '删掉一条密钥（不存在时什么也不做）',
    }),
  ],
  notifications: [],
  errors: secretsErrors,
})

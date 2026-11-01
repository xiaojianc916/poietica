import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { WorkBuddyCheckin, WorkBuddyLoginEvent, WorkBuddySnapshot } from './entities'
import { workbuddyErrors } from './errors'

export * from './entities'
export { workbuddyErrors } from './errors'

const empty = z.object({})

export const workbuddyContract = defineContract({
  id: 'workbuddy',
  namespaces: ['workbuddy'],
  methods: [
    defineMethod({
      name: 'workbuddy.snapshot',
      owner: 'core',
      params: empty,
      result: WorkBuddySnapshot,
      description: '读取 WorkBuddy 账号、积分、签到与反代状态',
    }),
    defineMethod({
      name: 'workbuddy.startBrowserLogin',
      owner: 'core',
      params: z.object({ accountId: z.string().nullable() }),
      result: z.object({ loginId: z.string(), url: z.string(), instructions: z.string() }),
      description: '开始浏览器登录；accountId 非空表示重新登录该账号',
    }),
    defineMethod({
      name: 'workbuddy.cancelLogin',
      owner: 'core',
      params: z.object({ loginId: z.string() }),
      result: empty,
      description: '放弃一次进行中的浏览器登录',
    }),
    defineMethod({
      name: 'workbuddy.addApiKey',
      owner: 'core',
      params: z.object({ apiKey: z.string().trim().min(8).max(512) }),
      result: z.object({ accountId: z.string() }),
      timeoutMs: 30_000,
      description: '用 WorkBuddy API Key 添加账号',
    }),
    defineMethod({
      name: 'workbuddy.removeAccount',
      owner: 'core',
      params: z.object({ accountId: z.string() }),
      result: empty,
      description: '移除一个 WorkBuddy 账号',
    }),
    defineMethod({
      name: 'workbuddy.setPreferred',
      owner: 'core',
      params: z.object({ accountId: z.string() }),
      result: empty,
      description: '设为首选账号',
    }),
    defineMethod({
      name: 'workbuddy.refreshUsage',
      owner: 'core',
      params: z.object({ accountId: z.string().nullable() }),
      result: WorkBuddySnapshot,
      timeoutMs: 60_000,
      description: '刷新一个或全部账号的积分',
    }),
    defineMethod({
      name: 'workbuddy.checkin',
      owner: 'core',
      params: z.object({ accountId: z.string() }),
      result: WorkBuddyCheckin,
      timeoutMs: 30_000,
      description: '领取该账号今天的积分',
    }),
    defineMethod({
      name: 'workbuddy.setEnabled',
      owner: 'core',
      params: z.object({ enabled: z.boolean() }),
      result: WorkBuddySnapshot,
      timeoutMs: 20_000,
      description: '启用或停用内置反代',
    }),
    defineMethod({
      name: 'workbuddy.setAutoCheckin',
      owner: 'core',
      params: z.object({ enabled: z.boolean() }),
      result: WorkBuddySnapshot,
      description: '打开或关闭每日自动签到',
    }),
    defineMethod({
      name: 'workbuddy.repairProvider',
      owner: 'core',
      params: empty,
      result: WorkBuddySnapshot,
      timeoutMs: 20_000,
      description: '重新启动反代并注册模型服务商',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'workbuddy.changed',
      owner: 'core',
      params: empty,
      description: 'WorkBuddy 账号、积分或反代状态变化',
    }),
    defineNotification({
      name: 'workbuddy.loginEvent',
      owner: 'core',
      params: WorkBuddyLoginEvent,
      description: '浏览器登录进度',
    }),
  ],
  errors: workbuddyErrors,
})

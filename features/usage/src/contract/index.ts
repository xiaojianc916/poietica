import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { DayKey, MessageCountDay, ModelDay, TokenDay } from './entities'
import { usageErrors } from './errors'

export * from './entities'
export { usageErrors } from './errors'

const _empty = z.object({})

/** 日期区间：from <= to，且跨度不超过 400 天（热力图要 53 周 = 371 天，留出余量）。 */
const MAX_RANGE_DAYS = 400
const DayRange = z
  .object({ from: DayKey, to: DayKey })
  .refine((range) => range.from <= range.to, { message: 'from 不能晚于 to' })
  .refine((range) => (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 < MAX_RANGE_DAYS, {
    message: `日期跨度不能超过 ${MAX_RANGE_DAYS} 天`,
  })

export const usageContract = defineContract({
  id: 'usage',
  namespaces: ['usage'],
  methods: [
    defineMethod({
      name: 'usage.tokenDays',
      owner: 'core',
      params: DayRange,
      result: z.object({ days: z.array(TokenDay) }),
      description: '按天汇总 token',
    }),
    defineMethod({
      name: 'usage.modelDays',
      owner: 'core',
      params: DayRange,
      result: z.object({ rows: z.array(ModelDay) }),
      description: '按天按模型汇总 token',
    }),
    defineMethod({
      name: 'usage.messageCount',
      owner: 'core',
      params: DayRange,
      /*
       * 口径是**用户发出去的句子数**（含插话），不是模型采样条数 —— 与 legacy 的
       * turn_admissions、ADR 0039 一致。表也换成 usage_messages（见 core/migrations.ts）。
       */
      result: z.object({ days: z.array(MessageCountDay) }),
      description: '按天统计用户发出的消息数',
    }),
  ],
  /*
   * 通知一条不剩：原先只有 usage.updated，它服务的线程标题栏那枚「累计用量」按钮已删
   * （见 refactor-log 偏差 #50）。设置页那三张图是「读一次 + 换窗口重读」，不靠推送。
   */
  notifications: [],
  errors: usageErrors,
})

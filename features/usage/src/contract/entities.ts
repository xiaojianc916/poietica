import { z } from 'zod'

export const DayKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
export type DayKey = z.infer<typeof DayKey>

export const TokenDay = z.object({
  day: DayKey,
  tokens: z.number().int(),
})
export type TokenDay = z.infer<typeof TokenDay>

export const ModelDay = z.object({
  day: DayKey,
  model: z.string(),
  tokens: z.number().int(),
})
export type ModelDay = z.infer<typeof ModelDay>

export const MessageCountDay = z.object({
  day: DayKey,
  count: z.number().int(),
})
export type MessageCountDay = z.infer<typeof MessageCountDay>

import { z } from 'zod'

export const WorkBuddyAccountKind = z.enum(['browser', 'api_key'])
export type WorkBuddyAccountKind = z.infer<typeof WorkBuddyAccountKind>

export const WorkBuddyAccountStatus = z.enum(['ok', 'expired', 'error'])
export type WorkBuddyAccountStatus = z.infer<typeof WorkBuddyAccountStatus>

export const WorkBuddyUsageWindow = z.object({
  name: z.string(),
  used: z.number().nullable(),
  amount: z.number().nullable(),
  limit: z.number().nullable(),
  balance: z.number().nullable(),
  unit: z.string().nullable(),
  display: z.string().nullable(),
  resetsAt: z.string().nullable(),
  runsOutAt: z.string().nullable(),
  span: z.number().nullable(),
  models: z.array(z.string()).nullable(),
  refused: z.boolean(),
})
export type WorkBuddyUsageWindow = z.infer<typeof WorkBuddyUsageWindow>

export const WorkBuddyUsage = z.object({
  plan: z.string().nullable(),
  windows: z.array(WorkBuddyUsageWindow),
  signIn: z.string().nullable(),
  error: z.string().nullable(),
})
export type WorkBuddyUsage = z.infer<typeof WorkBuddyUsage>

export const WorkBuddyCheckinOutcome = z.enum(['done', 'claimed', 'ineligible', 'inactive', 'failed'])
export type WorkBuddyCheckinOutcome = z.infer<typeof WorkBuddyCheckinOutcome>

export const WorkBuddyCheckin = z.object({
  at: z.number().int(),
  day: z.string(),
  outcome: WorkBuddyCheckinOutcome,
  credit: z.number().nullable(),
  streak: z.number().nullable(),
  message: z.string().nullable(),
})
export type WorkBuddyCheckin = z.infer<typeof WorkBuddyCheckin>

export const WorkBuddyAccount = z.object({
  id: z.string(),
  label: z.string(),
  uid: z.string(),
  kind: WorkBuddyAccountKind,
  plan: z.string().nullable(),
  preferred: z.boolean(),
  status: WorkBuddyAccountStatus,
  statusMessage: z.string().nullable(),
  usage: WorkBuddyUsage.nullable(),
  usageAt: z.number().int().nullable(),
  checkedInToday: z.boolean(),
  checkin: WorkBuddyCheckin.nullable(),
  createdAt: z.number().int(),
})
export type WorkBuddyAccount = z.infer<typeof WorkBuddyAccount>

export const WorkBuddyProviderState = z.enum(['disabled', 'registered', 'missing', 'conflict', 'error'])
export type WorkBuddyProviderState = z.infer<typeof WorkBuddyProviderState>

export const WorkBuddyProxy = z.object({
  enabled: z.boolean(),
  running: z.boolean(),
  port: z.number().int().nullable(),
  /** 隐去口令的调试地址，只给界面看。 */
  endpoint: z.string().nullable(),
  providerId: z.string(),
  providerState: WorkBuddyProviderState,
  providerMessage: z.string().nullable(),
})
export type WorkBuddyProxy = z.infer<typeof WorkBuddyProxy>

export const WorkBuddySnapshot = z.object({
  accounts: z.array(WorkBuddyAccount),
  proxy: WorkBuddyProxy,
  autoCheckin: z.boolean(),
})
export type WorkBuddySnapshot = z.infer<typeof WorkBuddySnapshot>

export const WorkBuddyLoginState = z.enum(['waiting', 'done', 'failed'])
export type WorkBuddyLoginState = z.infer<typeof WorkBuddyLoginState>

export const WorkBuddyLoginEvent = z.object({
  loginId: z.string(),
  state: WorkBuddyLoginState,
  accountId: z.string().nullable(),
  message: z.string().nullable(),
})
export type WorkBuddyLoginEvent = z.infer<typeof WorkBuddyLoginEvent>

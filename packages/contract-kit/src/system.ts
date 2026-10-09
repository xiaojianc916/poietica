import { z } from 'zod'
import { defineContract, defineErrors, defineMethod, defineNotification } from './define'

export const CORE_STATUS_STATES = ['starting', 'ready', 'restarting', 'failed', 'stopped'] as const
export const CORE_FAILURE_REASONS = [
  'start_timeout',
  'crashed',
  'crash_loop',
  'isolation_violated',
  'bad_arguments',
  'protocol_mismatch',
  'core_missing',
  'data_too_new',
  'start_failed',
] as const

export const coreStatusSchema = z.object({
  state: z.enum(CORE_STATUS_STATES),
  reason: z.enum(CORE_FAILURE_REASONS).nullable(),
  attempt: z.number().int().min(0),
})
export const coreReadySchema = z.object({
  coreVersion: z.string(),
  protocolVersion: z.number().int(),
  engineVersion: z.string(),
})
export const coreNoticeSchema = z.object({
  level: z.enum(['info', 'warn', 'error']),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
})

/** 系统错误码。键与 foundation 的 SystemErrorCode 一一对应（测试会核对），值是 UI 兜底显示的标题 */
export const systemErrors = defineErrors('kernel', {
  invalid_params: '参数无效',
  method_not_found: '未知的方法',
  not_found: '找不到对象',
  conflict: '操作冲突',
  cancelled: '操作已取消',
  timeout: '操作超时',
  core_unavailable: '后台服务不可用',
  core_restarted: '后台服务已重启',
  data_root_invalid: '数据目录无效',
  module_graph_invalid: '模块依赖关系无效',
  unhandled_method: '方法未实现',
  service_access_denied: '服务访问被拒绝',
  table_access_denied: '数据表访问被拒绝',
  protocol_mismatch: '版本不匹配',
  contract_invalid: '契约无效',
  io_error: '读写文件失败',
  internal: '内部错误',
})

/** 系统契约的 id：它由内核实现/消费，不属于任何功能 */
export const SYSTEM_CONTRACT_ID = 'system'

const empty = z.object({})

/** 由内核实现的系统契约（命名空间 core）。composeContracts 自动并入，功能契约不得使用 core 命名空间 */
export const systemContract = defineContract({
  id: SYSTEM_CONTRACT_ID,
  namespaces: ['core'],
  methods: [
    defineMethod({
      name: 'core.shutdown',
      owner: 'core',
      params: empty,
      result: empty,
      timeoutMs: 15_000,
      description: 'Host 请求 Core 优雅退出',
    }),
    defineMethod({
      name: 'core.restart',
      owner: 'host',
      params: empty,
      result: empty,
      timeoutMs: 60_000,
      description: '重新启动 Core 进程',
    }),
    defineMethod({
      name: 'core.getStatus',
      owner: 'host',
      params: empty,
      result: coreStatusSchema,
      description: '读取 Core 当前状态',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'core.ready',
      owner: 'core',
      params: coreReadySchema,
      description: 'Core 就绪（Host 消费，不转发给 UI）',
    }),
    defineNotification({
      name: 'core.status',
      owner: 'host',
      params: coreStatusSchema,
      description: 'Core 状态变化（CoreSupervisor 广播）',
    }),
    defineNotification({
      name: 'core.notice',
      owner: 'core',
      params: coreNoticeSchema,
      description: 'Core 主动提示',
    }),
  ],
  errors: systemErrors,
})

import type { AgentDescriptor } from '../agent-descriptor'

/*
 * Kimi Code CLI 的档案。
 *
 * 事实来源是它自己的源码，不是观察和猜测：MoonshotAI/kimi-code。每一条下面都
 * 注明具体是哪个文件的哪个函数。
 *
 * 我们接的是 kap：kimi web --no-open 起的本地服务（kap-server），REST +
 * WebSocket，协议快照钉在 contracts/kap（pnpm kap:spec）。
 */

/**
 * 提问方言。
 *
 * question.ts 的 optOptionId / skipOptionId 拼出 \`q\${questionIndex}_opt_\${optionIndex}\`
 * 与 \`q\${questionIndex}_skip\`，该文件注释把权威正则写成
 * /^q(\\d+)_(opt_(\\d+)|skip)$/。选项是 kind: 'allow_once'，Skip 是 'reject_once'。
 *
 * 题号今天恒为 0（适配器把多题降级成单题），但命名空间是上游为多题预留的，
 * 所以这里按 (\\d+) 收而不写死 q0：等上游放开，这两行不用动。
 *
 * 注意上游的回包解析 outcomeToQuestionAnswer 目前写死 /^q0_opt_(\\d+)$/，只认
 * 0 号题。我们收的是超集，方向上是安全的。
 */
const QUESTION_DIALECT = {
  option: /^q(\d+)_opt_(\d+)$/,
  skip: /^q(\d+)_skip$/,
}

/**
 * 按钮上的字。
 *
 * 键是上游审批按钮的规范英文：Approve once / Approve for this session /
 * Reject（CANONICAL_OPTIONS，上游 packages/acp-adapter/src/approval.ts；kap 下
 * 这三条由我们按协议的答复面合成，见 agent-runtime 的 permission.rs），计划评审
 * 两条（Revise / Reject and Exit），question.ts 追加的一条（Skip）。Allow /
 * Allow Always / Approve 是更早的文案：旧日志里记下的帧还带着那些名字，重放
 * 时翻的仍是它们。
 *
 * 计划评审里 plan_opt_* 的 name 是策略当场给的方案标签，本来就该原样显示，
 * 因此不在表内 —— 表只负责把规范英文换成中文，不负责改写 agent 说的话。
 */
const OPTION_LABELS = {
  Allow: '批准',
  'Allow Always': '始终批准',
  Approve: '批准',
  'Approve for this session': '始终批准',
  'Approve once': '批准',
  Reject: '拒绝',
  'Reject and Exit': '拒绝并退出',
  Revise: '修改方案',
  Skip: '跳过',
} as const

/*
 * 启动是一个可执行名加一串参数，不是一行待解析的命令行：拼成字符串再拆回来是
 * 有损的 —— Windows 路径里的反斜杠会被 POSIX 词法当成转义符吃掉，带空格的路径
 * 会被切断。
 */
export const kimiCode = {
  id: 'kimi',
  displayName: 'Kimi Code',
  command: 'kimi',
  /*
   * 本地服务模式：同一个进程挂 REST + WebSocket 与 web UI，--no-open 不起
   * 浏览器（docs/en/reference/kimi-command.md 的 kimi web）。
   */
  args: ['web', '--no-open'],
  // apps/kimi-code/src/config/paths.ts 的 resolveKimiHome：
  // homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code')。
  homeVar: 'KIMI_CODE_HOME',
  // 同一行 resolveKimiHome 的最后一个回落，也就是没有受控 home 时它自己去的地方。
  ownHomeDirectory: '.kimi-code',
  // docs/en/reference/kimi-command.md 的 provider catalog add：--api-key
  // "Falls back to KIMI_REGISTRY_API_KEY if not provided"。我们从不给 --api-key，
  // 所以走的一直是这条回落。
  registryKeyVar: 'KIMI_REGISTRY_API_KEY',
  // docs/en/reference/kimi-command.md：provider list --json 输出 providers / models 两张表。
  providerListArgs: ['provider', 'list', '--json'],
  // 上游用一个固定 id 把 KIMI_MODEL_API_KEY 之类的变量合成成一个 provider，落盘时剥掉。
  syntheticProviderId: '__kimi_env__',
  install: { packageName: '@moonshot-ai/kimi-code', versionArgs: ['--version'] },
  optionLabels: OPTION_LABELS,
  questionDialect: QUESTION_DIALECT,
} as const satisfies AgentDescriptor

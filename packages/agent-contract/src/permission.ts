/**
 * 「下一条会话该以哪种批准方式开始」的持久意图。
 *
 * 它既不是协议里的东西，也不是某条会话的状态。ACP 的 mode 是会话级活状态
 * （session/set_config_option 按 sessionId 寻址），而 session/new 不带配置参数，
 * 所以"重启之后还是我上次选的那个"协议自己答不出来。
 *
 * 上游也是这么分的：kimi-code 的 permissionMode 是 Agent scope 的 wire 状态，
 * 持久的那一份是 config 段 defaultPermissionMode（config.toml 的
 * default_permission_mode），文档原话是 only the persisted default applied at
 * main-agent creation。这个端口就是客户端这一侧的同一个位置。
 *
 * 实现由组合根交进来：意图存在哪、怎么落盘是宿主的事，域层只要求它读得出、
 * 写得进 —— 单测因此不需要任何 Storage。
 */
export interface PermissionPosturePort {
  /** 上次选的那一个。从没选过就是 undefined，那时权威是 agent 自己的默认值。 */
  readonly read: () => string | undefined
  readonly write: (value: string) => void
}

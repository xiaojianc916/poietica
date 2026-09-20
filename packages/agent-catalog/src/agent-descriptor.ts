/* 档案只收声明字段；要用钩子必须先写明声明为何不够。 */

export interface AgentInstall {
  readonly packageName: string
  readonly versionArgs: readonly string[]
}

export interface AgentDescriptor {
  readonly id: string
  readonly displayName: string
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly unsetEnv?: readonly string[] | undefined
  readonly homeVar?: string | undefined
  /** 不受控时这家 agent 在用户 home 之下的数据目录名；一次性导入去那里取它自己的配置与密钥。 */
  readonly ownHomeDirectory?: string | undefined
  readonly install?: AgentInstall | undefined
}

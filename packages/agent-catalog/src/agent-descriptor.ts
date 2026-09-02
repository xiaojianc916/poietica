/*
 * 一个 agent 的档案长什么样。
 *
 * kap 只规定协议本身。协议之上每一家仍有自己的写法：用什么命令启动、受控 home
 * 认在哪个环境变量上、运行时怎么装。这些不是协议的漏洞，是协议留给实现的自由。
 *
 * 档案就是把这份自由收成一张表。收法只有两种，判据只有一条：
 *
 *   各家不同的是「值」   → 声明字段。通用层那段代码对所有 agent 是同一份。
 *   各家不同的是「算法」 → 钩子函数。通用层没法靠换一个参数伺候第二家。
 *
 * 默认走声明。要用钩子，必须在档案里写清为什么声明不够 —— 没写理由的钩子只是
 * 把一个 if 换了个地方，不是解耦。
 *
 * 今天一个钩子都没有：已经发现的各家差异全都落在「值」这一侧。判据仍然写在
 * 这里，是为了将来真需要钩子时有个门槛 —— 一份档案至多一个，签名钉死，纯函数
 * （不碰全局状态、界面、网络、时钟），只在入站边界调用，通用层只有一个调用点。
 */

/**
 * 这个 agent 的运行时怎么装。
 *
 * 它是一个用户要自己装的外部 CLI，安装包里既没有 externalBin 也没有 resources。
 * 各家不同的只是「包名」与「问版本的参数」两个值，不是算法 —— 按本文件的判据，
 * 声明字段，不加钩子。
 *
 * 缺席表示我们说不出该怎么装它：界面于是什么都不画，而不是画一个点了会失败的按钮。
 */
export interface AgentInstall {
  /** npm 包名。安装与查最新版都只认它。 */
  readonly packageName: string
  /** 问已装版本的参数。输出里第一个 semver 就是答案。 */
  readonly versionArgs: readonly string[]
}

export interface AgentDescriptor {
  readonly id: string
  readonly displayName: string
  /**
   * 可执行文件名，不含参数。
   *
   * 起的是用户自己装的那个 CLI，名字是这一家的固有事实。
   */
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  /** 启动 agent 前从继承环境中移除的变量名。 */
  readonly unsetEnv?: readonly string[] | undefined
  /**
   * 受控 home 的环境变量名。
   *
   * 各家把自己的数据根目录认在哪个变量上，是那一家二进制的固有事实：
   * kimi-code 的 resolveKimiHome 逐字写着
   * homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code')。
   *
   * 只记名字，不记路径。路径由原生侧的 paths::agent_home 现算 —— 落盘一份
   * 会在换机或改安装位置之后变成一个指向不存在目录的死值。
   *
   * 各家不同的只是这个名字，通用层设变量那一行对谁都一样，所以是声明。
   * 缺席表示这一家不接受受控 home，启动时就不设这个变量。
   */
  readonly homeVar?: string | undefined
  /**
   * 不受控时，这家 agent 在用户 home 之下的数据目录名。
   *
   * 同样是那一家二进制的固有事实，就是 homeVar 那一行里的最后一个回落：
   * kimi-code 的 resolveKimiHome 逐字写着
   * homeDir ?? process.env['KIMI_CODE_HOME'] ?? join(homedir(), '.kimi-code')。
   *
   * 用途是回答「用户自己在命令行上配出来的那份配置在哪」——一次性导入要去那里取
   * 密钥。它由这张表说而不是由原生侧写死：写死等于让通用层认准一家的目录名，接
   * 第二家时会拿着 kimi 的目录去问别人的密钥。
   *
   * 只记名字，不记路径：用户 home 由原生侧现算。缺席表示我们说不出这一家把配置
   * 放在哪，那就不猜。
   */
  readonly ownHomeDirectory?: string | undefined
  readonly install?: AgentInstall | undefined
}

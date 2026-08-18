/*
 * 一个 ACP agent 的档案长什么样。
 *
 * ACP 只规定协议本身。协议之上每一家仍有自己的写法：用什么命令启动、把一道
 * 题塞进 session/request_permission 时 optionId 长什么样、终局帧到达后屏幕上
 * 该剩下什么。这些不是协议的漏洞，是协议留给实现的自由。
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
 * 「向用户提问」在这一家的写法。
 *
 * 提问不是 ACP 的概念，协议只有 session/request_permission。哪一家用什么形状的
 * optionId 把一道题塞进权限请求，是那一家的方言。
 *
 * 各家不同的只有这两条正则；通用层拿到之后干的事一模一样：exec，取两个捕获组，
 * 一个题号一个选项号。换第二家一行代码都不用改 —— 变的只是值，所以是声明。
 */
export interface QuestionDialect {
  /** 捕获 (题号, 选项号)。 */
  readonly option: RegExp
  /** 捕获 (题号)。 */
  readonly skip: RegExp
}

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
  /**
   * 起这个 agent 时必须设上的环境变量。
   *
   * 与 homeVar 是两件事，方向正好相反：homeVar 记的是「它把数据根目录认在哪个
   * 变量名上」，值由原生侧现算；这里记的是「名字和值我们都说得出来」的那种变量,
   * 因为它们是这家二进制的固有事实，不是用户的选择。
   *
   * 为什么需要它：args 有时只是一个决定的一半。kimi 的 acp-v2 子命令是条件注册
   * 的 —— 上游 apps/kimi-code/src/cli/commands.ts 用 isAcpV2Enabled 决定要不要
   * registerAcpV2Command，判据在 cli/experimental-v2.ts 里逐字是
   * KIMI_CODE_EXPERIMENTAL_ACP_V2 属于 {'1','true','yes','on'}。开关没开时，
   * commander 对这个名字的回答是 unknown command，而不是「功能没启用」。
   *
   * 声明在这里而不是在用户档案里，是为了让两半同处一处：谁改了 args，会在同一屏
   * 看见跟着要改的变量。此前它们分处两地，其中一地是空的。
   *
   * 各家不同的只是这张表，通用层把它并进启动环境那一步对谁都一样，所以是声明。
   * 缺席表示这一家不需要任何固定变量。
   */
  readonly launchEnv?: Readonly<Record<string, string>> | undefined
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
  /**
   * 从目录添加 provider 时，密钥该注入哪个环境变量。
   *
   * 密钥不能上命令行（Windows 上任何用户都读得到别的进程的完整命令行），所以只剩
   * 环境变量一条路；而变量叫什么名字是各家自己的事：kimi-code 的 resolveApiKey
   * 在 --api-key 缺席时回落 KIMI_REGISTRY_API_KEY。
   *
   * 各家不同的只是这个名字，通用层注入那一行对谁都一样，所以是声明。
   * 缺席表示这一家不接受由我们代填密钥，界面就不给写入入口。
   */
  readonly registryKeyVar?: string | undefined
  /**
   * 问这一家要「已配置的 provider 与模型」时的完整子命令序列。
   *
   * 各家 CLI 的子命令名不同（kimi 是 provider list --json），而通用层拿它去
   * 执行的那一行对谁都一样 —— 变的是值，所以是声明。
   *
   * 此前它是 provider 解析那一侧的一个模块常量（同包的 provider-state.ts），
   * 也就是说通用层写死了一家的子命令名。缺席表示这一家没有这种查询，界面就
   * 不给这个入口。
   */
  readonly providerListArgs?: readonly string[] | undefined
  /**
   * 由环境变量合成、不可编辑的那个保留 provider id。
   *
   * 它是各家自己的实现细节（kimi 是 __kimi_env__，落盘时会被剥掉），通用层只
   * 需要知道「这一条不该给编辑与删除入口」。同样是值，所以是声明。
   */
  readonly syntheticProviderId?: string | undefined
  readonly install?: AgentInstall | undefined
  /**
   * 权限选项按钮上写什么。
   *
   * 键是这一家送来的 name（协议里的 human-readable label），不是 kind：kind 是
   * 分类，一次请求里会重复，拿它当标签会让几个不同的选项显示成同一个词。
   * 查不到的一律照原文显示，所以这张表只需要列出想改口的那几条。
   *
   * 各家不同的只是这张表，通用层查表那一行对谁都一样 —— 变的是值，所以是声明。
   */
  readonly optionLabels: Readonly<Record<string, string>>
  /** 缺席表示这一家不用权限请求提问。 */
  readonly questionDialect?: QuestionDialect | undefined
}

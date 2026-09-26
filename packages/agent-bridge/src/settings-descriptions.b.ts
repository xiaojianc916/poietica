/*
 * omp 设置的**说明文字**中文表 —— 分片 b。
 *
 * 与 settings-labels.ts 同构：键是 omp 的 **path**，值是这一格说明的中文。
 * 分片只为并行翻译切开，语义上是一张表；由 settings-descriptions.ts 合并成一份。
 * 查不到就原样返回 omp 的英文说明（同 labels 的安全属性）：缺一条翻译只是不好看。
 */

export const DESCRIPTIONS_B: Readonly<Record<string, string>> = {
  // ── appearance ──────────────────────────────────────────────────────────
  colorBlindMode: 'diff 新增行用蓝色而不是绿色',
  'images.autoResize': '把大图缩到最大 2000x2000，以提升模型兼容性',
  'images.blockImages': '阻止把图片发送给 LLM 供应商',
  'display.shimmer': '工作/加载提示的动画样式',
  'display.hideToolActivity': '在对话记录里隐藏模型主动发起的工具调用及其结果',
  'display.showTokenUsage': '在助手消息上显示每轮的 token 用量',
  'display.showTurnTime': '在助手消息的用量行上显示从提交提示词到让出控制权的总耗时（含工具调用）',
  'display.cacheMissMarker':
    '某一轮请求未命中（丢失）prompt 缓存时，在该助手轮次之后显示一条分隔线',
  'display.collapseCompacted':
    '在实时对话记录里把压缩前的历史折叠到摘要分隔线之后；关闭则完整历史内联显示，并在每个压缩点插入分隔线',

  // ── context ─────────────────────────────────────────────────────────────
  'workspace.additionalDirectories':
    '给每个会话追加的额外工作区根目录（多根工作区）。可用 /add-dir 与 /remove-dir 实时增删。路径相对 cwd 解析，建议用绝对路径。agent 会被告知这些根目录存在，可对它们读取/grep/glob。',
  'contextPromotion.enabled': '上下文溢出时提升到更大上下文的模型，而不是压缩',
  extendedContext:
    '在支持的前提下使用更大的上下文窗口；可能产生高价位计费。关闭则保持默认或标准价位的窗口',
  'compaction.enabled': '上下文过大时自动压缩',
  'compaction.experimentalContextManagement':
    '跨上下文窗口保留持久笔记与可检索的原始历史。改动后需重启才会更新可用工具。',
  'compaction.midTurnEnabled': '在轮内工具循环的安全边界上、向供应商发起下一次请求之前检查阈值',
  'compaction.methodOrder': '自动维护上下文时的首选回退顺序；某种方式不可用或失败就改用下一项',
  'compaction.thresholdPercent':
    '触发上下文维护的百分比阈值；设为 Default 则沿用旧版按保留量计算的行为',
  'compaction.thresholdTokens': '触发上下文维护的固定 token 上限；设置后覆盖百分比',
  'compaction.handoffSaveToDisk': '把生成的交接文档存成 markdown 文件，供自动交接流程使用',
  'compaction.remoteStreamingV2Enabled': '对兼容的远程压缩模型使用 Responses 流式压缩',
  'compaction.asyncEnabled': '上下文接近压缩阈值时在后台预先总结，越过阈值后把已算好的结果拼接进来',
  'compaction.idleEnabled': '空闲且 token 数超过阈值时压缩上下文',
  'compaction.idleThresholdTokens': '空闲压缩被触发的 token 数下限',
  'compaction.idleTimeoutSeconds': '空闲后等待多少秒再压缩',
  'compaction.supersedeReads': '同一文件被再次读取时剪掉较早的读取结果（缓存感知，每轮都会执行）',
  'compaction.dropUseless':
    '剪掉被判定为对上下文无用的工具结果（无匹配、等待超时），一经消费即剪（缓存感知）',
  'snapcompact.systemPrompt':
    '实验特性：把选中的系统提示词文本渲染成高密度 PNG 图片并附加到第一条用户消息（仅视觉模型）。可省 token；被转成图片的文本会失去 prompt 缓存。',
  'snapcompact.toolResults':
    '实验特性：把较大的历史工具结果渲染成高密度 PNG 图片而不是文本（仅视觉模型）。可省下累积的读取/搜索输出所占的 token。',
  'tools.format':
    '控制工具以何种方式暴露给模型。Auto 使用供应商原生的工具调用，除非所选模型被标记为不支持，此时回退到 GLM 自有方言。Native 强制使用供应商原生工具；其余取值强制使用对应的具名自有方言。会话启动时生效。',
  'snapcompact.shape':
    'snapcompact 打印文本所用的框线形状（压缩归档与内联成像）。Auto 会挑选适配当前模型的形状。',
  'branchSummary.enabled': '离开分支时提示生成摘要',
  'ttsr.enabled': '输出匹配规则模式时打断流式中的 agent（Time-Traveling Stream Rules）',
  'ttsr.judge':
    '对每条 `question` 规则，让 judge 模型角色审阅已完成的回复、推理与工具调用；判定为是则把该规则作为警告注入',
  'ttsr.contextMode': 'TTSR 触发时如何处理已产生的部分输出',
  'ttsr.interruptMode': '何时在流式中打断，何时在完成后注入警告',
  'ttsr.repeatMode': '规则可以如何重复触发：每个会话一次，或间隔若干条消息后',
  'ttsr.repeatGap': '规则再次触发前需间隔的消息数',
  'ttsr.builtinRules': '加载 agent 自带的内置规则（可用 ttsr.disabledRules 逐条覆盖）',
  'ttsr.disabledRules': '完全忽略的规则名（对内置默认规则与你自己的规则同样生效）',

  // ── memory ──────────────────────────────────────────────────────────────
  'memory.backend': '关闭、本地摘要流水线、Mnemopi SQLite、Hindsight 远程记忆，或 Sharpshooter',
  'sharpshooter.model': '负责抽取/整合的模型选择，留空 = 使用 smol 角色',
  'autolearn.enabled': 'agent 停止后提醒它把经验教训沉淀到记忆，并创建/增强彼此隔离的受管技能',
  'autolearn.autoContinue':
    '开启时，停止处自动跑一轮私密的经验沉淀（会额外消耗 token）。关闭时只保留常驻的自动学习指引。',
  'mnemopi.dbPath': '可选的 SQLite 数据库路径。默认为 agent 的记忆目录。',
  'mnemopi.bank': '可选的共享记忆库基础名。按项目隔离的各模式会据此派生出项目本地记忆库。',
  'mnemopi.scoping':
    'global = 一个共享记忆库；per-project = 按 cwd 各自隔离记忆库；per-project-tagged = 写入项目本地，同时召回时可见全局',
  'mnemopi.embeddingVariant':
    '本地嵌入模型系列。en = 英文更强的模型；multilingual = 跨语言模型。改动后会在下次启动时重建已有的记忆嵌入。',
  'mnemopi.autoRecall': '在每个会话的第一轮召回本地记忆',
  'mnemopi.autoRetain': '把已完成的对话轮次留存进本地 Mnemopi 记忆',
  'mnemopi.polyphonicRecall': '启用四路召回（向量、图、事实、时间）并以倒数排名融合（RRF）合并',
  'mnemopi.enhancedRecall': '为重复或相似的召回查询启用分层查询结果缓存',
  'mnemopi.proactiveLinking': '新记忆入库时即写入事件图，并与相关实体与记忆建立关联',
  'mnemopi.noEmbeddings': '强制只用确定性的 FTS 召回，不用向量嵌入',
  'mnemopi.embeddingModel':
    '高级：显式指定嵌入模型 id，覆盖 mnemopi.embeddingVariant。留空则使用 mnemopi.embeddingVariant。',
  'mnemopi.embeddingApiUrl': '传给 Mnemopi 的可选 OpenAI 兼容嵌入端点',
  'mnemopi.embeddingApiKey': '传给 Mnemopi 的可选嵌入 API 密钥',
  'mnemopi.llmMode':
    '不使用 LLM、使用在线微型模型（/models 里的 TINY 角色，否则 @smol），或使用远程 OpenAI 兼容端点',
  'mnemopi.llmBaseUrl': 'Mnemopi 远程模式的可选 OpenAI 兼容 LLM 端点',
  'mnemopi.llmApiKey': 'Mnemopi 远程模式的可选 LLM API 密钥',
  'mnemopi.llmModel': 'Mnemopi 远程模式的可选 LLM 模型名',
  'hindsight.apiUrl': 'Hindsight 服务器地址（Cloud 或自托管）',
  'hindsight.apiToken': '用于需鉴权的 Hindsight 服务器的 Bearer token',
  'hindsight.bankId': '记忆库标识（默认：项目名）',
  'hindsight.scoping':
    'global = 一个共享记忆库；per-project = 按 cwd 各自隔离记忆库；per-project-tagged = 共用记忆库并打上项目标签，召回时全局与项目记忆合并',
  'hindsight.autoRecall': '在每个会话的第一轮召回记忆',
  'hindsight.autoRetain': '每隔 N 轮以及会话结束时留存对话记录',
  'hindsight.retainMode': 'full-session = 每个会话 upsert 一个文档；last-turn = 分块',
  'hindsight.mentalModelsEnabled':
    '启动时把整理好的反思摘要（心智模型）读入开发者指令。只加载记忆库上已有的模型，不写入。可与 hindsight.mentalModelAutoSeed 搭配，同时自动创建内置的种子集合。',
  'hindsight.mentalModelAutoSeed':
    '会话开始时，在记忆库上创建尚不存在的内置心智模型（project-conventions、project-decisions、user-preferences）。',

  // ── tasks ───────────────────────────────────────────────────────────────
  'plan.enabled': '启用计划模式，在执行前先做只读探索与规划',
  'plan.autosave': '计划模式完成时自动把已批准的计划保存到磁盘',
  'plan.autosaveDir':
    '自动保存计划的目录。支持 ~、绝对路径与相对 cwd 的路径。留空使用 <project>/.omp/plans/。',
  'goal.enabled': '启用每会话的目标模式与隐藏的 goal 工具',
  'goal.continuationModes': '活跃目标可在轮次之间自动续跑的运行模式',
  'title.refreshOnReplan': '待办初始化导致重新规划后刷新自动生成的会话标题，除非标题是用户设定的',
  'task.isolation.enabled': '在检出的隔离副本中运行子代理，事后再把改动集成回来',
  'isolation.backend': '子代理隔离与工作树克隆所使用的后端',
  'worktree.clone':
    '由 `github pr_checkout` 与 bash 里的 `git worktree add` 新建的工作树，先作为当前检出的写时复制克隆，使被忽略的构建产物（node_modules、target）一并带过去；文件系统不支持克隆时回退为普通检出',
  'worktree.cleanSource':
    '用 `/wt` 创建工作树时，把改动带过去之后重置原检出中已跟踪文件的改动并删除未跟踪文件',
  'task.isolation.apply': '自动把成功的隔离任务改动应用到父检出；关闭则保留补丁或分支产物',
  'task.isolation.merge': '隔离任务的改动如何集成（应用补丁或合并分支）',
  'task.isolation.commits': '嵌套仓库改动的提交信息风格（通用或 AI 生成）',
  'worktree.base':
    'agent 管理工作树的根目录 —— 任务隔离副本、`github` 的 PR 检出以及 `omp worktree` 的清理都放在这里。未设置时使用 ~/.omp/wt。必须是绝对路径或 ~ 相对路径；相对路径会被忽略。环境变量 OMP_WORKTREE_DIR 会覆盖此项。',
  'task.eager': '把工作派给子代理的推动力度',
  'task.batch':
    '把 task 工具切换为批量形态：一次调用携带 { context, tasks[] } —— 每项一个子代理，可逐项指定 agent（默认用会话的 spawn-policy agent）、可逐项设置隔离，并有一段必填的共享 context 前置到每个任务上。async.enabled=true 时每次派发都作为独立后台 agent 运行，走正常的空闲/停驻生命周期；否则该调用会阻塞到结果合并返回。关闭则恢复扁平的单个派发形态。',
  'task.enableEffort': '在 task 派发上暴露可选的 effort 参数，允许调用方覆盖每个子代理的思考档位',
  'task.maxConcurrency': '同时运行的子代理数量上限',
  'task.enableLsp':
    '允许经 task 工具派生的子代理使用 lsp 工具。默认关闭以控制子代理开销；当感知 LSP 的派发值得多花这些 token 时再开启。',
  'task.maxRecursionDepth': '子代理最多可以再派生几层子代理',
  'task.maxRuntimeMs':
    '每个子代理的硬性墙钟时限（毫秒）。0 表示不限制。这是针对绕过推理层看门狗的供应商侧流挂起的纵深防御；会以正常方式中止子代理，理由为 “timed out”。',
  'task.agentIdleTtlMs':
    '空闲子代理在内存中保持存活多久后被停驻到磁盘（毫秒）。被停驻的 agent 在收到消息或恢复时会自动唤醒。0 表示空闲 agent 一直存活到退出。',
  'task.softRequestBudget':
    '每个子代理的请求软预算（每次运行的助手请求数）。超过它会注入一条收尾提醒（见 task.softRequestBudgetNotice）；达到预算的 1.5 倍时该次运行被强制停止，agent 必须交回已获得的部分结论。0 表示关闭该保护。内置的 scout/sonic agent 另有更低的内置预算上限，低于该上限的取值对它们仍然生效。',
  'task.softRequestBudgetNotice':
    '子代理越过请求软预算时注入一条提醒，请它在 1.5 倍强制收尾停止之前收尾',
  'task.maxEffort':
    'task 工具每次派发的思考档位提示所允许的最大推理档位。取值更低可防止调用方把子代理抬高到此上限之上；默认保留模型的完整档位范围。',
  'task.prewalk':
    '为内置的通用 `task` 子代理启用 prewalk：它以自己解析出的模型起步，规划并开始实现，在第一次编辑/写入时交接给 smol 角色。单个 agent 的覆盖设置（task.agentPrewalk，在 /agents 中心配置）与用户 agent 的 `prewalk` frontmatter 都与此开关无关，始终生效。',
  'task.showResolvedModelBadge': '在 task 部件的状态行里显示每个子代理实际使用的模型 ID',
  'skills.enableSkillCommands': '把技能注册为 /skill:name 命令',
  'commands.enableClaudeUser': '从 ~/.claude/commands/ 加载命令',
  'commands.enableClaudeProject': '从 .claude/commands/ 加载命令',
  'commands.enableOpencodeUser': '从 ~/.config/opencode/commands/ 加载命令',
  'commands.enableOpencodeProject': '从 .opencode/commands/ 加载命令',
}

/*
 * omp 那 378 格设置的中文文案。
 *
 * omp 不带 i18n（整棵依赖树里没有一个 locale 文件），它的 label 与 group 只有英文。
 * 这一份表就是补上的那一层：**以 omp 自己的标识符为键** —— 栏目用它的 tab key，
 * 分节用它的英文 group 原文，每一格用它的 **path**（`theme.dark`）而不是英文 label。
 * 按 path 键是有意的：path 是稳定标识符，英文 label 是会自动改词的散文。
 *
 * 命中不到就原样返回 omp 的英文（见 tabLabelOf / groupLabelOf / settingLabelOf）。
 * 这是本文件的安全属性，不是兜底补丁：omp 将来加一格、加一节，页面显示英文，
 * 而不是把这格藏起来或显示空白 —— 缺一条翻译最多是不好看，缺一格设置是缺陷。
 * 也正因为是「查不到就返回原文」，这一份表不需要与 omp 版本同步：它只会少，不会错。
 */

import {
  getUi,
  SETTINGS_SCHEMA,
  type SettingPath,
} from '@oh-my-pi/pi-coding-agent/config/settings-schema'

/** 栏目名：键是 omp 的 tab key（settings.ts 的 SETTING_TABS）。 */
const TAB_LABELS: Readonly<Record<string, string>> = {
  appearance: '外观',
  model: '模型',
  interaction: '交互',
  context: '上下文',
  memory: '记忆',
  files: '文件',
  /* 这一栏装的是 Bash 与 eval 那些命令设置，不是「终端界面」—— 译成「终端」会让人以为它管外观。 */
  shell: '命令与执行',
  tools: '工具',
  tasks: '任务',
  providers: '供应商',
}

/** 分节名：键是 omp 的英文 group 原文（会随它改词，查不到就退回英文）。 */
const GROUP_LABELS: Readonly<Record<string, string>> = {
  Advisor: '顾问',
  Agent: 'Agent 行为',
  Approvals: '审批',
  'Auto-Learn': '自动学习',
  'Available Tools': '可用工具',
  Collab: '协作',
  'Commands & Skills': '命令与技能',
  Compaction: '上下文压缩',
  Composer: '输入区',
  Computer: '电脑控制',
  Developer: '开发调试',
  'Discovery & MCP': '工具发现与 MCP',
  Display: '显示',
  Editing: '编辑',
  'Eval & Runtimes': 'Eval 与运行时',
  Execution: '执行',
  Experimental: '实验特性',
  Extensions: '扩展',
  General: '通用',
  'Grep & Browser': 'Grep 与浏览器',
  Images: '图像',
  Input: '输入',
  Isolation: '隔离',
  'Magic Keywords': '魔法关键词',
  Modes: '模式',
  Notifications: '通知',
  'Output Limits': '输出上限',
  Power: '电源',
  Privacy: '隐私',
  Prompt: '提示词',
  Protocol: '协议',
  'Read Summaries': '读取摘要',
  Reading: '读取',
  'Retry & Fallback': '重试与回退',
  'Rules (TTSR)': '规则（TTSR）',
  Sampling: '采样',
  Services: '服务',
  Skills: '技能',
  Speech: '语音',
  'Startup & Updates': '启动与更新',
  'Status Line': '状态栏',
  Stream: '直播',
  Subagents: '子代理',
  Theme: '主题',
  Thinking: '思考',
  Timeouts: '超时',
  'Tiny Model': '微型模型',
  Todos: '待办',
  Vision: '视觉',
  /*
   * 不在表里的那 9 条分节名（Bash / Fireworks / Git / GitHub / Hindsight / LSP /
   * Mnemopi / Prewalk / Sharpshooter）是产品名与协议名，刻意不译 —— 译了人反而认不出
   * 说的是哪一个产品。它们由兜底原样上屏，不需要在这里抄一遍英文原文：
   * 抄一遍就与「忘了译」长得一模一样，反而分不出谁是谁。
   */
}

/**
 * 每一格的标题：键是 omp 的 **path**（不是英文 label）。
 *
 * 同一件事的译法在全表里只出现一次：面板、预设、分隔符、阈值…每一步都取同一个词。
 */
const SETTING_LABELS: Partial<Record<SettingPath, string>> = {
  // ── appearance ──────────────────────────────────────────────────────────
  'theme.dark': '深色主题',
  'theme.light': '浅色主题',
  symbolPreset: '符号风格',
  colorBlindMode: '色盲模式',
  'composer.shape': '输入区形态',
  'composer.tokenRate': '生成速率',
  'statusLine.preset': '状态栏预设',
  'statusLine.separator': '状态栏分隔符',
  'statusLine.contextLine': '上下文指示线',
  'statusLine.sessionAccent': '会话强调色',
  'statusLine.transparent': '透明状态栏',
  'statusLine.compactThinkingLevel': '紧凑思考档位',
  'statusLine.showHookStatus': '显示钩子状态',
  'terminal.showImages': '显示内嵌图片',
  'images.autoResize': '自动缩放图片',
  'images.blockImages': '拦截图片',
  'tui.resizeScrollback': '回滚缓冲重排',
  'terminal.showProgress': '终端原生进度',
  'tui.textSizing': '大号标题（Kitty）',
  'tui.renderMermaid': '渲染 Mermaid 图',
  'tui.reactions': 'Agent 表情回应',
  'tui.codexResetFireworks': 'Codex 额度重置烟花',
  'tui.titleState': '标题显示运行状态',
  'tui.titleSpinner': '标题忙碌动画',
  'tui.hyperlinks': '终端超链接',
  'tui.mouse': '鼠标点击聚焦',
  'tui.tight': '紧凑布局',
  'display.shimmer': '微光动画',
  'display.pinnedAgents': '置顶 Agent 列表',
  'display.smoothStreaming': '平滑流式输出',
  'display.hideToolActivity': '隐藏工具活动',
  'display.showTokenUsage': '显示 Token 用量',
  'display.showTurnTime': '显示轮次耗时',
  'display.cacheMissMarker': '缓存未命中标记',
  'display.collapseCompacted': '折叠已压缩历史',
  showHardwareCursor: '显示硬件光标',
  'tui.imeSafeCursor': '输入法安全的输入布局',
  'task.showResolvedModelBadge': '显示实际使用的模型',

  // ── model ───────────────────────────────────────────────────────────────
  'advisor.enabled': '启用顾问',
  'prewalk.enabled': '启用 Prewalk',
  'advisor.syncBacklog': '顾问同步积压',
  'advisor.immuneTurns': '顾问免打断轮数',
  'advisor.maxNotesPerUpdate': '单次顾问建议上限',
  modelRoleStorage: '模型角色存储位置',
  'images.describeForTextModels': '为纯文本模型描述图片',
  'images.urls.enabled': '以 URL 提供图片',
  'images.urls.backends': '图片 URL 后端',
  'images.urls.command': '图片上传命令',
  'images.urls.publicBaseUrl': '图片 URL 公开地址',
  'images.urls.ttlHours': '图片 URL 有效期（小时）',
  'images.urls.bindHost': '图片 URL 绑定地址',
  'images.urls.sshTarget': '图片 URL SSH 目标',
  'images.urls.sshRemotePort': '图片 URL SSH 远程端口',
  defaultThinkingLevel: '思考档位',
  hideThinkingBlock: '隐藏思考块',
  proseOnlyThinking: '思考只留散文',
  omitThinking: '省略思考摘要',
  externalThinking: '外部思考',
  'model.loopGuard.enabled': '循环防护',
  'model.loopGuard.checkAssistantContent': '循环防护扫描正文',
  'model.loopGuard.toolCallReminder': '循环防护工具调用提醒',
  'model.toolCallLoopGuard.enabled': '工具调用循环防护',
  'model.toolCallLoopGuard.threshold': '工具调用循环阈值',
  'model.toolCallLoopGuard.exemptTools': '工具调用循环豁免工具',
  inlineToolDescriptors: '内联工具描述',
  includeModelInPrompt: '提示词中带上模型',
  includeWorkspaceTree: '提示词中带上工作区树',
  skillful: '提示词中列出技能',
  personality: '性格',
  temperature: '温度',
  topP: 'Top P',
  topK: 'Top K',
  minP: 'Min P',
  presencePenalty: '存在惩罚',
  repetitionPenalty: '重复惩罚',
  textVerbosity: '文本详略度',
  'tier.openai': '服务档位 — OpenAI',
  'tier.anthropic': '服务档位 — Anthropic',
  'tier.google': '服务档位 — Google',
  'tier.subagent': '服务档位 — 子代理',
  'tier.advisor': '服务档位 — 顾问',
  'retry.maxRetries': '重试次数',
  'retry.maxDelayMs': '最大重试间隔',
  'retry.waitForUsageReset': '等待额度重置',
  'retry.modelFallback': '重试时回退模型',
  'retry.usageAwareFallback': '额度感知回退',
  'retry.usageReservePct': '保留余量',
  'retry.usageReservePolicy': '保留策略',
  'retry.fallbackChains': '回退链路',
  'retry.fallbackRevertPolicy': '回退恢复策略',
  'providers.anthropic.serverSideFallback': 'Anthropic 服务端回退（Fable 5）',
  'providers.autoThinkingMaxEffort': '自动思考上限',

  // ── interaction ─────────────────────────────────────────────────────────
  autoResume: '自动恢复上次会话',
  'power.sleepPrevention': '阻止系统休眠',
  'git.enabled': '启用 Git 集成',
  steeringMode: '插话模式',
  followUpMode: '追问模式',
  interruptMode: '打断模式',
  'tui.vimMode': 'Vim 编辑模式',
  'tui.vimModeDisplay': 'Vim 模式指示器',
  'loop.mode': '循环模式',
  'loop.conditionTimeoutMs': '循环条件超时（毫秒）',
  'composer.recallClearedDrafts': '召回已清空的草稿',
  doubleEscapeAction: '连按两次 Escape',
  treeFilterMode: '会话树筛选',
  autocompleteMaxVisible: '自动补全条数',
  'spelling.typoDetection': '拼写错误检测（macOS）',
  'spelling.autocomplete': '单词补全（macOS）',
  'spelling.autocorrect': '自动纠错（macOS）',
  emojiAutocomplete: 'Emoji 自动补全',
  'paste.largeMenuThreshold': '大段粘贴菜单',
  'startup.quiet': '安静启动',
  'startup.showSplash': '显示启动画面',
  'startup.setupWizard': '设置向导',
  'startup.checkUpdate': '检查更新',
  'update.channel': '更新通道',
  'marketplace.autoUpdate': '插件市场自动更新',
  'startup.changelogMode': '启动更新日志',
  'magicKeywords.enabled': '魔法关键词',
  'magicKeywords.ultrathink': 'Ultrathink 关键词',
  'magicKeywords.orchestrate': 'Orchestrate 关键词',
  'magicKeywords.workflow': 'Workflow 关键词',
  'magicKeywords.jevify': 'Jevify 关键词',
  'completion.notify': '完成通知',
  'error.notify': '出错通知',
  'ask.timeout': '提问超时',
  'ask.notify': '提问通知',
  'recap.enabled': '空闲回顾',
  'recap.idleSeconds': '空闲回顾延迟',
  'collab.relayUrl': '中继地址',
  'collab.webUrl': 'Web 界面地址',
  'collab.displayName': '显示名称',
  'collab.autoStart': '自动开启协作',
  'share.serverUrl': '分享服务地址',
  'share.store': '分享存储位置',
  'share.redactSecrets': '分享时脱敏密钥',
  'stream.serverUrl': '直播服务地址',
  'stream.redactPatterns': '额外脱敏规则',
  'skills.registryUrl': '技能仓库地址',
  'stt.enabled': '语音转文字',
  'stt.submitTrigger': '语音转文字发送时机',
  'tools.approval': '逐工具审批策略',
  'tools.approvalMode': '工具审批',
  'features.unexpectedStopDetection': '意外停止',

  // ── context ─────────────────────────────────────────────────────────────
  'workspace.additionalDirectories': '额外工作区目录',
  'contextPromotion.enabled': '自动提升上下文',
  extendedContext: '扩展上下文',
  'compaction.enabled': '自动压缩',
  'compaction.experimentalContextManagement': '笔记式上下文窗口（实验）',
  'compaction.midTurnEnabled': '轮中压缩',
  'compaction.methodOrder': '压缩方式顺序',
  'compaction.thresholdPercent': '压缩阈值',
  'compaction.thresholdTokens': '压缩 Token 上限',
  'compaction.handoffSaveToDisk': '保存交接文档',
  'compaction.remoteStreamingV2Enabled': '远程压缩 V2',
  'compaction.asyncEnabled': '异步压缩',
  'compaction.idleEnabled': '空闲压缩',
  'compaction.idleThresholdTokens': '空闲压缩阈值',
  'compaction.idleTimeoutSeconds': '空闲压缩延迟',
  'compaction.supersedeReads': '替换过期读取',
  'compaction.dropUseless': '丢弃无用结果',
  'snapcompact.systemPrompt': 'Snapcompact 系统提示词',
  'snapcompact.toolResults': 'Snapcompact 工具结果',
  'tools.format': '工具调用模式',
  'snapcompact.shape': 'Snapcompact 形状',
  'branchSummary.enabled': '分支摘要',
  'ttsr.enabled': 'TTSR',
  'ttsr.judge': '判定式规则',
  'ttsr.contextMode': 'TTSR 上下文处理',
  'ttsr.interruptMode': 'TTSR 打断方式',
  'ttsr.repeatMode': 'TTSR 重复方式',
  'ttsr.repeatGap': 'TTSR 重复间隔',
  'ttsr.builtinRules': '内置规则',
  'ttsr.disabledRules': '已禁用规则',

  // ── memory ──────────────────────────────────────────────────────────────
  'memory.backend': '记忆后端',
  'sharpshooter.model': 'Sharpshooter 模型',
  'autolearn.enabled': '自动学习（实验）',
  'autolearn.autoContinue': '停止时自动沉淀',
  'mnemopi.dbPath': 'Mnemopi 数据库路径',
  'mnemopi.bank': 'Mnemopi 记忆库',
  'mnemopi.scoping': 'Mnemopi 作用域',
  'mnemopi.embeddingVariant': '嵌入模型系列',
  'mnemopi.autoRecall': 'Mnemopi 自动回忆',
  'mnemopi.autoRetain': 'Mnemopi 自动留存',
  'mnemopi.polyphonicRecall': 'Mnemopi 多路召回',
  'mnemopi.enhancedRecall': 'Mnemopi 增强召回',
  'mnemopi.proactiveLinking': 'Mnemopi 主动关联',
  'mnemopi.noEmbeddings': 'Mnemopi 禁用向量嵌入',
  'mnemopi.embeddingModel': 'Mnemopi 嵌入模型',
  'mnemopi.embeddingApiUrl': 'Mnemopi 嵌入接口地址',
  'mnemopi.embeddingApiKey': 'Mnemopi 嵌入 API 密钥',
  'mnemopi.llmMode': 'Mnemopi LLM 模式',
  'mnemopi.llmBaseUrl': 'Mnemopi LLM 接口地址',
  'mnemopi.llmApiKey': 'Mnemopi LLM API 密钥',
  'mnemopi.llmModel': 'Mnemopi LLM 模型',
  'hindsight.apiUrl': 'Hindsight 接口地址',
  'hindsight.apiToken': 'Hindsight API 令牌',
  'hindsight.bankId': 'Hindsight 记忆库 ID',
  'hindsight.scoping': 'Hindsight 作用域',
  'hindsight.autoRecall': 'Hindsight 自动回忆',
  'hindsight.autoRetain': 'Hindsight 自动留存',
  'hindsight.retainMode': 'Hindsight 留存方式',
  'hindsight.mentalModelsEnabled': 'Hindsight 心智模型',
  'hindsight.mentalModelAutoSeed': 'Hindsight 心智模型自动生成',

  // ── files ───────────────────────────────────────────────────────────────
  'edit.mode': '编辑模式',
  'edit.fuzzyMatch': '模糊匹配',
  'edit.fuzzyThreshold': '模糊匹配阈值',
  'edit.streamingAbort': '预览失败即中止',
  'edit.recoverInlineEdits': '恢复内联编辑载荷',
  'edit.blockAutoGenerated': '拦截自动生成的文件',
  'edit.enforceSeenLines': '已见行校验',
  'edit.blackbox.enabled': '记录解析回归',
  'edit.autoRepair.enabled': '自动修复解析回归',
  readLineNumbers: '显示行号',
  'read.defaultLimit': '默认读取行数',
  'read.renderMarkdown': 'Markdown 预览',
  'read.summarize.enabled': '读取摘要',
  'read.summarize.prose': '散文摘要',
  'read.summarize.minBodyLines': '摘要正文行数下限',
  'read.summarize.minCommentLines': '摘要注释行数下限',
  'read.summarize.minTotalLines': '摘要最小文件行数',
  'read.summarize.unfoldUntil': '摘要展开目标',
  'read.summarize.unfoldLimit': '摘要展开上限',
  'read.toolResultPreview': '内联读取预览',
  'lsp.enabled': 'LSP',
  'lsp.lazy': 'LSP 延迟启动',
  'lsp.shared': '共享语言服务器',
  'lsp.formatOnWrite': '写入时格式化',
  'lsp.diagnosticsOnWrite': '写入后诊断',
  'lsp.diagnosticsOnEdit': '编辑后诊断',
  'lsp.diagnosticsDeduplicate': '诊断去重',

  // ── shell ───────────────────────────────────────────────────────────────
  'bash.enabled': 'Bash',
  'bash.allowCompoundCommands': '允许复合命令',
  'bash.autoBackground.enabled': 'Bash 自动转后台',
  'bash.patterns': 'Bash 审批规则',
  'bashInterceptor.enabled': 'Bash 拦截器',
  'bash.direnv': 'direnv 自动加载',
  'bash.direnvLoadTimeoutMs': 'direnv 加载超时（毫秒）',
  'shellMinimizer.enabled': 'Shell 输出精简',
  'shellMinimizer.sourceOutlineLevel': '源码大纲级别',
  'eval.py': 'Python Eval 后端',
  'eval.js': 'JavaScript Eval 后端',
  'eval.autoProvision': 'Eval 环境自动准备',
  'eval.tools.enabled': 'Eval 自定义工具',
  'eval.workpool.freshAgents': 'Workpool 全新子代理',
  'eval.autoBackground.enabled': 'Eval 自动转后台',
  'python.kernelMode': 'Python 内核模式',
  'python.interpreter': 'Python 解释器',

  // ── tools ───────────────────────────────────────────────────────────────
  'tools.artifactSpillThreshold': '产物落盘阈值（KB）',
  'tools.artifactTailBytes': '产物尾部保留（KB）',
  'tools.artifactHeadBytes': '产物头部保留（KB）',
  'tools.outputMaxColumns': '单行列数上限',
  'tools.artifactTailLines': '产物尾部行数',
  'todo.enabled': '待办',
  'todo.reminders': '待办提醒',
  'todo.remindersMax': '待办提醒上限',
  'todo.eager': '自动创建待办',
  'glob.enabled': 'Glob',
  'grep.enabled': 'Grep',
  'grep.contextBefore': 'Grep 上文行数',
  'grep.contextAfter': 'Grep 下文行数',
  'astGrep.enabled': 'AST Grep',
  'astEdit.enabled': 'AST Edit',
  'find.enabled': 'Find（语义搜索）',
  'debug.enabled': 'Debug',
  'launch.enabled': '服务管理',
  'speechgen.enabled': '语音生成',
  'generate_image.enabled': '生成图片',
  'computer.enabled': '电脑控制',
  'computer.display': '电脑控制显示器',
  'computer.maxWidth': '截图最大宽度',
  'computer.maxHeight': '截图最大高度',
  'images.questionTimeoutMs': '图片提问超时',
  'checkpoint.enabled': '检查点 / 回退',
  'fetch.enabled': '读取 URL',
  'vault.enabled': 'Obsidian 仓库',
  'github.enabled': 'GitHub CLI',
  'github.cache.enabled': 'GitHub 视图缓存',
  'github.cache.softTtlSec': 'GitHub 缓存软过期',
  'github.cache.hardTtlSec': 'GitHub 缓存硬过期',
  'web_search.enabled': '网页搜索',
  'security.enabled': '安全扫描',
  'ask.enabled': 'Ask',
  'browser.enabled': '浏览器',
  'browser.cdpUrl': '浏览器 CDP 地址',
  'browser.relay': '浏览器中继',
  'browser.relayUrl': '浏览器中继地址',
  'browser.headless': '无头浏览器',
  'browser.cmux': 'cmux 浏览器',
  'browser.freezeOnTurnEnd': '轮次结束时冻结标签页',
  'browser.idleCloseSec': '浏览器空闲关闭超时',
  'browser.screenshotDir': '截图保存目录',
  'tools.intentTracing': '意图追踪',
  'tools.abortOnFabricatedResult': '伪造工具结果即中止',
  'tools.speculativeExecution.enabled': '实验性预测执行',
  'tools.speculativeExecution.maxInFlight': '预测执行并发数',
  'tools.maxTimeout': '工具最大超时',
  'async.enabled': '异步执行',
  'tools.xdev': 'xd:// 工具',
  'tools.xdevDocs': 'xd:// 提示词文档',
  'tools.xdevInlineDevices': 'xd:// 内联设备',
  'mcp.enableProjectConfig': 'MCP 项目配置',
  'mcp.startupTimeoutMs': 'MCP 启动等待',
  'mcp.renderMarkdownResults': 'MCP Markdown 结果',
  'mcp.notifications': 'MCP 更新注入',
  'mcp.notificationDebounceMs': 'MCP 通知防抖',
  'tasks.todoClearDelay': '待办自动清除延迟',
  'extensionHandlers.toolCallTimeoutMs': '工具调用处理器超时（毫秒）',
  'dev.autoqa': '自动 QA',
  'dev.autoqaPush.endpoint': '自动 QA 上报地址',

  // ── tasks ───────────────────────────────────────────────────────────────
  'plan.enabled': '计划模式',
  'plan.defaultOnStartup': '启动时进入计划模式',
  'plan.autosave': '自动保存计划',
  'plan.autosaveDir': '计划保存目录',
  'goal.enabled': '目标模式',
  'goal.statusInFooter': '页脚显示目标状态',
  'goal.continuationModes': '目标续跑模式',
  'title.refreshOnReplan': '重规划时刷新标题',
  'task.isolation.enabled': '隔离子代理',
  'isolation.backend': '隔离后端',
  'worktree.clone': '检出克隆进工作树',
  'worktree.cleanSource': '/wt 时清理源检出',
  'task.isolation.apply': '自动应用隔离改动',
  'task.isolation.merge': '隔离合并策略',
  'task.isolation.commits': '隔离提交信息风格',
  'worktree.base': '工作树根目录',
  'task.eager': '优先派发给子代理',
  'task.batch': '批量派发任务',
  'task.enableEffort': '逐任务思考档位',
  'task.maxConcurrency': '最大并发子代理数',
  'task.enableLsp': '子代理使用 LSP',
  'task.maxRecursionDepth': '子代理最大递归层数',
  'task.maxRuntimeMs': '子代理最长运行时长',
  'task.agentIdleTtlMs': '子代理空闲驻留时长',
  'task.softRequestBudget': '子代理请求软预算',
  'task.softRequestBudgetNotice': '请求预算提醒',
  'task.maxEffort': '单次派发最大档位',
  'task.prewalk': '通用任务 Prewalk',
  'skills.enableSkillCommands': '技能命令',
  'commands.enableClaudeUser': 'Claude 用户命令',
  'commands.enableClaudeProject': 'Claude 项目命令',
  'commands.enableOpencodeUser': 'OpenCode 用户命令',
  'commands.enableOpencodeProject': 'OpenCode 项目命令',

  // ── providers ───────────────────────────────────────────────────────────
  'providers.maxInFlightRequests': '最大并发请求数',
  'providers.openai-codex.codeMode': 'Codex 代码模式',
  'providers.openai-codex.codeModeDirectTools': 'Codex 代码模式直连工具',
  'secrets.enabled': '隐藏密钥',
  'providers.ollama-cloud.maxConcurrency': 'Ollama Cloud 最大并发数',
  'providers.webSearchTimeoutSeconds': '网页搜索超时',
  'providers.antigravityEndpoint': 'Antigravity 端点模式',
  'providers.fireworksTier': 'Fireworks 档位',
  'live.voice': '实时语音音色',
  'tts.localVoice': '本地 TTS 音色',
  'speech.enabled': '语音朗读',
  'speech.mode': '语音朗读范围',
  'speech.enhanced': '语音朗读改写',
  'speech.voice': '语音朗读音色',
  'providers.tinyModelDevice': '微型模型设备',
  'providers.tinyModelDtype': '微型模型精度',
  'providers.kimiApiFormat': 'Kimi API 格式',
  'providers.openaiWebsockets': 'OpenAI WebSocket',
  'providers.cacheRetention': '提示词缓存保留',
  'providers.streamFirstEventTimeoutSeconds': '流首事件超时',
  'providers.streamIdleTimeoutSeconds': '流空闲超时',
  'providers.openrouterVariant': 'OpenRouter 路由',
  'providers.fetch': '网页抓取后端',
  'codexResets.autoRedeem': 'Codex 自动使用已存重置',
  'codexResets.minBlockedMinutes': 'Codex 自动重置最小阻塞',
  'codexResets.keepCredits': 'Codex 自动重置保留量',
  'codexResets.salvageHorizonHours': 'Codex 重置抢救时限',
  'claudeResets.autoRedeem': 'Claude 自动使用已存重置',
  'claudeResets.minBlockedMinutes': 'Claude 自动重置最小阻塞',
  'claudeResets.keepCredits': 'Claude 自动重置保留量',
  'claudeResets.salvageHorizonHours': 'Claude 重置抢救时限',
  'provider.appendOnlyContext': '仅追加上下文',
  'exa.enabled': 'Exa',
  'exa.searchDelayMs': 'Exa 搜索间隔',
  'searxng.endpoint': 'SearXNG 地址',
}

/**
 * 某一格的中文标题；没有译文时原样交出 omp 的英文。
 *
 * `fallback` 是 omp 自报的 label，查不到表就返回它 —— 表只可能少不会错。
 */
export function settingLabelOf(path: string, fallback: string): string {
  return SETTING_LABELS[path as SettingPath] ?? fallback
}

/** 某一栏的中文名；没有译文时原样交出 tab key。 */
export function tabLabelOf(tab: string): string {
  return TAB_LABELS[tab] ?? tab
}

/** 某一节的中文名；没有译文时原样交出 omp 的英文 group。 */
export function groupLabelOf(group: string): string {
  return GROUP_LABELS[group] ?? group
}

/** 这一格有没有中文标题。界面用它决定要不要把英文原文排在次要位置。 */
export function hasSettingTranslation(path: string): boolean {
  return SETTING_LABELS[path as SettingPath] !== undefined
}

/**
 * 某一格的英文原文，给界面排在中文旁边当次要文字用。
 *
 * 从 agent 自己的 schema 现读，不在本文件抄第二份：抄一遍就与「上游改了词」分不出来，
 * 而这一份的用处正是让人能拿它去搜 omp 的文档。
 *
 * 判据是 `SETTINGS_SCHEMA` 的成员检查，不是 `hasUi` / `getUi`：那两个对认不出的路径
 * 不是返回 undefined 而是**抛**（它们直接对空定义做 `in`，18.3.0 实测），而这里的调用方
 * 是「拿一个可能过时的路径来查原文」，抛出去正好砸在最不该出错的降级路径上。
 * 认不出就交回空串，界面据此不画那一行。
 */
export function settingLabelSource(path: string): string {
  return path in SETTINGS_SCHEMA ? (getUi(path as SettingPath)?.label ?? '') : ''
}

/**
 * 这一格是不是跟这台桌面软件无关。
 *
 * 判据是「我们这条边车进程跑不跑得到它的读取点」，逐条对着 omp 18.3.0 的源码核过。
 * 边车是「omp 的 SDK 编进一个无界面进程」：会话、工具、任务、记忆、MCP、LSP 这些跑；
 * 终端渲染、CLI 子命令、启动向导、终端里的键盘与语音不跑 —— 那些格子改了没有任何效果，
 * 画出来只是让人以为它能用。
 *
 * 为什么按插件删除而不是收起来：**画一格没有作用的控件就是骗人**。它让人以为改了会变。
 * 上游以后加新的同类格子，我们的名单不会自动跟上 —— 但那种代价（少一个没人能用的开关）
 * 远小于把「改了没效果」当成设置摆给人看。名单短、每条有理由，才核对得过来。
 */
const IRRELEVANT: readonly { readonly why: string; readonly test: (path: string) => boolean }[] = [
  { why: '终端渲染', test: (p) => p.startsWith('tui.') },
  { why: '终端渲染', test: (p) => p.startsWith('terminal.') },
  { why: '终端状态行', test: (p) => p.startsWith('statusLine.') },
  { why: '终端配色（改它对我们界面一个像素都不动）', test: (p) => p.startsWith('theme.') },
  { why: '终端字形与光标', test: (p) => p === 'symbolPreset' || p === 'showHardwareCursor' },
  { why: '终端输入区', test: (p) => p.startsWith('composer.') },
  /* agent 是被嵌进来的：启动、自更新、市场都由宿主管。 */
  { why: 'agent 自己的启动与自更新', test: (p) => p.startsWith('startup.') },
  { why: 'agent 自己的启动与自更新', test: (p) => p.startsWith('update.') },
  { why: 'agent 自己的启动与自更新', test: (p) => p.startsWith('marketplace.') },
  /* 桌面端有自己的输入法、补全与快捷键，不吃终端那一套。 */
  { why: '终端键盘与补全', test: (p) => p.startsWith('spelling.') },
  { why: '终端键盘与补全', test: (p) => p === 'doubleEscapeAction' },
  { why: '终端键盘与补全', test: (p) => p === 'autocompleteMaxVisible' },
  { why: '终端键盘与补全', test: (p) => p === 'treeFilterMode' },
  { why: '终端键盘与补全', test: (p) => p === 'emojiAutocomplete' },
  { why: '终端键盘与补全', test: (p) => p === 'paste.largeMenuThreshold' },
  { why: '终端键盘与补全', test: (p) => p === 'composer.recallClearedDrafts' },
  /* 语音与朗读的入口都在终端里（麦克风、逐字朗读）；桌面端没有这两条路。 */
  { why: '语音（终端入口）', test: (p) => p.startsWith('speech.') },
  { why: '语音（终端入口）', test: (p) => p === 'stt.enabled' },
  { why: '语音（终端入口）', test: (p) => p === 'live.voice' },
  /* 终端那一行怎么画：桌面端有自己的时间线与折叠。 */
  { why: '终端一行的画法', test: (p) => p === 'hideThinkingBlock' },
  { why: '终端一行的画法', test: (p) => p === 'proseOnlyThinking' },
  { why: '终端一行的画法', test: (p) => p === 'display.pinnedAgents' },
  { why: '终端一行的画法', test: (p) => p === 'display.smoothStreaming' },
  /*
   * `display.collapseCompacted` 刻意**不删**：它读的是一个传给 buildSessionContext 的
   * 选项（`options.transcript && collapseCompactedHistory`，session-context.ts:192/405），
   * 而我们自己也走那条读取路径 —— 删掉就是替它判断，而这里证据不足。
   */
  /* 终端里的提示与通知。 */
  { why: '终端提示与通知', test: (p) => p === 'completion.notify' || p === 'error.notify' },
  { why: '终端提示与通知', test: (p) => p === 'recap.enabled' || p === 'recap.idleSeconds' },
  { why: '终端提示与通知', test: (p) => p === 'git.enabled' },
  { why: '终端提示与通知', test: (p) => p === 'goal.statusInFooter' },
  { why: '终端提示与通知', test: (p) => p === 'stream.redactPatterns' },
  { why: '终端提示与通知', test: (p) => p === 'tasks.todoClearDelay' },
  /* 终端会话自己的节奏。 */
  { why: '终端会话的节奏', test: (p) => p === 'autoResume' },
  { why: '终端会话的节奏', test: (p) => p.startsWith('loop.') },
  { why: '终端会话的节奏', test: (p) => p === 'plan.defaultOnStartup' },
]

/**
 * 这一格跟这台桌面软件有没有关系。
 *
 * 名字说的是「有没有关系」，不是「是不是终端的」—— 判据里既有终端渲染，也有
 * agent 自己的启动/更新与终端键盘，后两者与终端无关，同样是这里用不上的东西。
 */
export function irrelevantSettingOf(path: string, group: string | undefined): boolean {
  /*
   * 分节级的判据**不用**：`Theme` 那一节里就有 `colorBlindMode`（「diff 新增用蓝色而不是
   * 绿色」）—— 它改的是我们自己也画的 diff，删掉就是砍掉一个真能力。分节的边界不等于
   * 有没有用；只有逐条路径的判据才算数。
   */
  void group

  return IRRELEVANT.some((rule) => rule.test(path))
}

/*
 * 产品**已经有专属控件**管着的那几格。
 *
 * 这不是「有没有用」的问题，是**一个事实两个控件**（AGENTS.md §1：每类状态有且只有一个
 * 所有者）。`plan.enabled` 在输入框那一排已经有一个「计划 / 直接执行」的选择器，
 * `goal.enabled`、`defaultThinkingLevel`、`tools.approvalMode` 同理；`browser.*` 三格在
 * 设置页「电脑控制」一节里有专门的一栏。再在 agent 设置里摆一个同名开关，人就会看到两个
 * 控件说同一件事 —— 改一个另一个不同步，而且没有任何迹象说明哪个算数。
 *
 * **只标不删**：这些格子的**值**还有别人要读 —— 界面按 `condition` 决定要不要画某些行
 * （`plan.autosave` 要 `plan.enabled` 为真、`providers.autoThinkingMaxEffort` 要
 * `defaultThinkingLevel` 是 auto），而那些判据读的就是目录里这一格的 value。把格子整个
 * 抽掉，那两行会永远不显示，且屏幕上没有任何迹象说明为什么。所以：值照报，行不画。
 *
 * 判据是「产品里已经有一处能改它」，不是「我觉得该由谁管」。每一行都要能指到代码。
 */
const CONTROLLED_ELSEWHERE: readonly string[] = [
  /* 桥的选择器（main.ts 的 readSelectors）——输入框那一排。 */
  'plan.enabled',
  'goal.enabled',
  'defaultThinkingLevel',
  'tools.approvalMode',
  /* 设置页「电脑控制」一节（agent_browser_settings / agent_set_browser_settings）。 */
  'browser.enabled',
  'browser.headless',
  'browser.cdpUrl',
]

/** 这一格的**行**由产品别处的控件负责；值仍然要报（有别的格子按它决定显不显示）。 */
export function ownedElsewhereOf(path: string): boolean {
  return CONTROLLED_ELSEWHERE.includes(path)
}

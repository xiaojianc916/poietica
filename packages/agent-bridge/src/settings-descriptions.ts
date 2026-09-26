/*
 * omp 设置的中文说明。
 *
 * omp 自己没有 i18n（实测：整个 @oh-my-pi 树零语言包、零翻译函数），所以中文只能我们出。
 * 键是 omp 自己的 **path**（不是英文 label）：path 是稳定标识符，label 是会自动改词的散文。
 * 查不到就原样交回 omp 的英文说明 —— 这是这张表作为「第二份事实」的唯一安全阀：
 * 上游加一格设置时我们只是没翻，不会漏能力，也不会显示空白（AGENTS.md §0）。
 *
 * 说明是给「决定要不要翻这个开关」的人读的，所以译的是行为而不是词；数字、单位、
 * `service_tier` 这类代码片段与 omp、MCP 这类产品/协议名一律原样保留。
 */

export const DESCRIPTIONS: Readonly<Record<string, string>> = {
  // ── model 与 tools ──────────────────────────────────────────────────────
  'advisor.enabled': '指派第二个模型（advisor 角色）被动审查每一轮，并注入批注。',
  'prewalk.enabled':
    '先用当前模型开工，在计划提示生成出待办清单之后的第一次编辑/写入时，切到快速便宜的模型（默认 smol 角色）—— 强模型负责规划、提交待办并开始实现，然后交接。可用 --prewalk / --no-prewalk 逐会话覆盖。',
  'advisor.syncBacklog': '顾问落后达到这么多轮时，把主 Agent 暂停最多 30 秒。关闭则不做追赶等待。',
  'advisor.immuneTurns':
    '顾问的关切或阻塞打断过之后，接下来的这么多主轮次里，进一步的关切/阻塞改为不打断地投递。',
  'advisor.maxNotesPerUpdate':
    '每次顾问提示词更新最多接受多少条非阻塞建议（1–32；界面提供 1–5 的快捷选项）。阻塞不受此限。',
  modelRoleStorage: '模型选择器里角色分配的保存位置',
  'tools.artifactSpillThreshold': '超过这个大小的工具输出会存为产物，只把尾部留在对话里',
  'tools.artifactTailBytes': '输出落盘为产物时，仍内联保留的尾部内容量',
  'tools.artifactHeadBytes':
    '输出落盘为产物时，与尾部一起内联保留的头部内容量（中间被省略）。0 关闭 —— 只留尾部。',
  'tools.outputMaxColumns':
    '流式工具输出（bash、python、js eval）与 `read` 的单行字节上限。超过这个宽度的行会被截断成省略号，到下个换行之间的剩余字节随之丢弃。0 关闭。',
  'tools.artifactTailLines': '输出落盘为产物时，仍内联保留的尾部行数上限',
  'images.describeForTextModels':
    '给不支持视觉的模型附带图片时，把图片存到 local:// 下，改注入一段来自支持视觉的模型的描述，而不是把它丢掉',
  'images.urls.enabled':
    '通过配置好的后端链对外发布图片，向抓取 URL 的供应商发送短 URL 而不是内联 base64。所有后端或某次供应商抓取失败时，自动退回内联。',
  'images.urls.backends': '发布图片供供应商访问时，按顺序尝试的目标',
  'images.urls.command':
    'command 后端的 argv 模板；{file} 是图片路径，{mime}/{ext} 可选。取 stdout 上打印的最后一个 URL（例如 pasta -b -f {file}）',
  'images.urls.publicBaseUrl': '位于 blob 服务器之前的对外可达基础 URL（ssh 必填，direct 可选）',
  'images.urls.ttlHours':
    '本地托管图片 URL 的服务窗口，从最近一次有对话发送它们时算起；恢复对话会在同一个链接上重新计时。0 表示只要 broker 还在运行，链接就一直有效',
  'images.urls.bindHost': 'blob 服务器绑定的主机；走隧道用回环地址，direct 直服填 0.0.0.0',
  'images.urls.sshTarget': 'SSH 反向转发的 user@host 目标',
  'images.urls.sshRemotePort': 'SSH 反向转发的远程监听端口，由你的 Web 服务器代理过去',
  defaultThinkingLevel: '支持思考的模型的推理深度',
  omitThinking: '指示上游供应商在响应中完全省略思考摘要（在支持的地方）',
  externalThinking: '私有草稿板；不展示给用户。会禁用受支持的 GPT、Claude 与 Gemini 推理',
  'model.loopGuard.enabled': '为模型推理与正文启用自动流式循环检测',
  'model.loopGuard.checkAssistantContent': '除思考日志外，也对助手正文消息启用循环防护',
  'model.loopGuard.toolCallReminder':
    '当 Gemini 推理流连续输出多个规划标题却不调用工具时，打断它并注入一条提醒，要求发出工具调用（需开启循环防护）',
  'model.toolCallLoopGuard.enabled': '检测跨轮次连续相同的工具调用，并注入一条纠正性插话',
  'model.toolCallLoopGuard.threshold': '注入纠正性插话前，需要连续出现多少次相同工具调用',
  'model.toolCallLoopGuard.exemptTools': '允许连续重复而不触发跨轮循环防护的工具名',
  inlineToolDescriptors:
    '在系统提示词中渲染完整工具描述，并从供应商工具 schema 中剥掉顶层/嵌套描述，让描述文本只发送一次。Auto 对 Gemini 模型启用、其余情况关闭',
  includeModelInPrompt: '在系统提示词中标出当前模型标识，让 Agent 知道自己用的是哪个模型',
  includeWorkspaceTree:
    '在系统提示词中渲染工作区目录树。警告：文件被修改时，这可能让提示词缓存在跨会话之间失效。',
  skillful: '在系统提示词中列出可用技能；关闭可省上下文，并可用 /skillful 逐会话切换',
  personality: '渲染进系统提示词性格块的沟通风格',
  temperature: '采样温度（0 = 确定性输出，1 = 有创造性，-1 = 供应商默认值）',
  topP: '核采样截断阈值（0-1，-1 = 供应商默认值）',
  topK: '从概率最高的 K 个 token 中采样（-1 = 供应商默认值）',
  minP: '最小概率阈值（0-1，-1 = 供应商默认值）',
  presencePenalty: '对引入已出现过的 token 施加的惩罚（-1 = 供应商默认值）',
  repetitionPenalty: '对重复 token 施加的惩罚（-1 = 供应商默认值）',
  textVerbosity: 'OpenAI Responses 与 Codex 响应的详略度（low、medium 或 high）',
  'tier.openai':
    'OpenAI / OpenAI-Codex 请求，以及经 OpenRouter 路由的 OpenAI 系模型的处理档位（none = 不发送）。以 `service_tier` 发送。',
  'tier.anthropic':
    'Claude 请求的处理档位。`priority` 在支持直连的 Anthropic 模型上实现快速模式（`speed: "fast"`）；在 Bedrock/Vertex 的 Claude 上以及经 OpenRouter 时被忽略。',
  'tier.google':
    'Gemini（Google AI Studio + Vertex）请求，以及经 OpenRouter 路由的 Google 系模型的处理档位（none = 不发送）。以顶层 `serviceTier` 字段发送。',
  'tier.subagent':
    '派生任务/eval 子代理的服务档位。Inherit = 跟随主 Agent 按家族实时生效的档位（会跟着 /fast 变）；选一个具体值则应用到子代理模型所属的那个家族。',
  'tier.advisor':
    '顾问模型的服务档位。None = 标准处理；Inherit = 跟随主 Agent 按家族实时生效的档位；选一个具体值则应用到顾问模型所属的家族。',
  'retry.maxRetries': 'API 出错时的最大重试次数',
  'retry.maxDelayMs':
    '两次重试之间的最长等待，单位毫秒。供应商要求的等待超过这个值、而又没有可用的凭据或模型回退时，请求快速失败而不是睡下去（例如 Anthropic 三小时的限流窗口）。0 取消这个上限 —— 让会话能顺着供应商给出的额度重置点自动恢复。',
  'retry.waitForUsageReset':
    '当供应商报告额度用尽并给出重置时间时（任何供应商的 5 小时或每周配额窗口），一直等到重置，而不是超过 retry.maxDelayMs 就快速失败。等待可以中止（Esc），但也会拖住子代理，无人值守的跑批请保持关闭。',
  'retry.modelFallback': '允许重试恢复时切换到配置好的回退模型',
  'retry.usageAwareFallback':
    '利用可靠的编程套餐额度报告，在撞上硬性额度上限之前，先用同一供应商的其他账号，其次才是配置好的回退模型。普通配置的 API 密钥不在此列。',
  'retry.usageReservePct':
    '剩余百分比低于此值时，就把编程套餐模型视为接近上限。用量未知或没有映射时仍用主模型。',
  'retry.usageReservePolicy': '当同一供应商的所有编程套餐账号都落进保留余量之内时该怎么做',
  'retry.fallbackChains': `JSON 对象，把模型角色、模型选择器（"provider/model-id"）或供应商通配（"provider/*"）映射到有序的回退选择器，例如 {"default":["openai/gpt-4o-mini"],"google-antigravity/*":["google/*","google-vertex/*"]}。以模型为键的条目在该模型/供应商生效时始终适用，与角色无关；"provider/*" 条目保留出错模型的 id 而换掉供应商。带 id 前缀的通配（"openrouter/google/*"）会给错误模型的裸 id 重新加前缀（google-antigravity/gemini-x -> openrouter/google/gemini-x），作为键使用时则只匹配该前缀下这个供应商的 id。回退条目可以带显式思考后缀（"provider/model:low"、":high"、":max"、":off"）；不带后缀的条目继承出错那一轮的思考档位，而 "provider/*" 条目始终继承。`,
  'retry.fallbackRevertPolicy': '回退之后什么时候回到主模型',
  'providers.anthropic.serverSideFallback':
    '当 Claude Fable 5 / Mythos 5 请求被 Anthropic 的安全分类器拦截时，在服务端改用 Claude Opus 5.5 重试（Anthropic 的 `server-side-fallback-2026-06-01` beta）。需要主动开启 —— 保持关闭会让每个请求都维持回退之前的行为。',
  'todo.enabled': '启用待办工具做任务跟踪',
  'todo.reminders': '在收尾前提醒 Agent 把待办做完',
  'todo.remindersMax': '放弃之前最多提醒多少次待办',
  'todo.eager': '首条消息之后，多用力推动自动创建待办清单',
  'glob.enabled': '启用 glob 工具做基于 glob 的文件查找',
  'grep.enabled': '启用 grep 工具做 regex 内容搜索',
  'grep.contextBefore': '每个 grep 命中之前的上下文行数',
  'grep.contextAfter': '每个 grep 命中之后的上下文行数',
  'astGrep.enabled': '启用 ast_grep 工具做结构化 AST 搜索',
  'astEdit.enabled': '启用 ast_edit 工具做结构化 AST 改写',
  'find.enabled':
    '启用 find 工具：用自然语言搜索文件与行区间，由 judge 模型角色判定。Auto 只在 judge 角色解析为原生 TypeSafe jev 模型时启用它',
  'debug.enabled': '启用 debug 工具做基于 DAP 的调试',
  'launch.enabled': '启用具名 bash 服务与 proc:// 监督，用于共享的长期项目进程',
  'speechgen.enabled': '启用 tts 工具做端上（Kokoro）或 xAI Grok Voice 语音文件合成',
  'generate_image.enabled':
    '启用 generate_image 工具（文生图与图像编辑）。当 tools.xdev 开启时，它以 xd:// 设备的形式暴露。',
  'computer.enabled': '启用可脚本化的宿主桌面 eval 前奏（截图、输入、无障碍）',
  'computer.display': '合成所有显示器，或选择一个原生显示器 id',
  'computer.maxWidth': '合成截图的最大宽度（像素）',
  'computer.maxHeight': '合成截图的最大高度（像素）',
  'images.questionTimeoutMs':
    'read 的 ?q= 图片提问背后那次视觉模型调用的单次请求超时，单位毫秒。卡住的供应商会以超时错误快速失败，而不是一直阻塞到人工中止。设为 0 关闭超时。',
  'checkpoint.enabled': '启用检查点与回退工具做上下文检查点',
  'fetch.enabled': '允许 read 工具抓取并处理 URL',
  'vault.enabled':
    '启用 vault:// 内部 URL，以便通过 Obsidian CLI 读取和编辑 Obsidian 仓库内容。关闭时，vault:// 解析会被拒绝，系统提示词里也不再出现 vault:// 条目。',
  'github.enabled':
    '启用 github 工具（以 op 分发的仓库、issue、pull request、diff、搜索、checkout、push 与 Actions watch 工作流）',
  'github.cache.enabled':
    '把渲染好的 issue/PR 视图输出缓存在 ~/.omp/cache/github-cache.db，让重复读取免费',
  'github.cache.softTtlSec': '在这个窗口内，缓存的 issue/PR 视图行直接返回（秒；默认 5 分钟）',
  'github.cache.hardTtlSec':
    '超过软过期后，仍返回缓存行并在后台刷新；超过硬过期则丢弃（秒；默认 7 天）',
  'web_search.enabled': '启用 web_search 工具获取实时网页结果',
  'security.enabled': '启用 OMP 原生的安全扫描规划、执行，以及只读的 security:// 资源命名空间',
  'ask.enabled': '启用 ask 工具向用户提出交互式问题',
  'browser.enabled': '启用浏览器 eval 前奏做脚本化的 Chromium 自动化（Puppeteer）',
  'browser.cdpUrl':
    '默认的 HTTP CDP 发现端点（例如 http://127.0.0.1:9222），用来附着而不是新起一个浏览器。工具调用里显式给出的 app.cdp_url 或 app.path 优先。',
  'browser.relay':
    '通过 omp 浏览器中继驱动你自己的 Chrome 标签页。装一次扩展（`omp browser-relay install`）；浏览器前奏需要时中继服务器会自动启动。优先于浏览器 CDP 地址；设 PI_BROWSER_RELAY=0 或 PI_BROWSER_RELAY=1 可覆盖。',
  'browser.relayUrl': 'omp 浏览器中继端点（默认 http://127.0.0.1:9224）。',
  'browser.headless': '以无头模式启动浏览器（关闭后显示浏览器界面）',
  'browser.cmux':
    '有 cmux socket 可用时，用 cmux WKWebView 界面做浏览器自动化。设 PI_BROWSER_CMUX=0 或 PI_BROWSER_CMUX=1 可覆盖。',
  'browser.freezeOnTurnEnd':
    '一轮结束时冻结 OMP 名下的无头浏览器标签页，让动画页面在空闲时不再烧 CPU/GPU。标签页下次使用时自动解冻；open 时传 persist:true 可让某个标签页不冻结。',
  'browser.idleCloseSec':
    '关闭空闲超过这么多秒的 OMP 名下无头浏览器标签页（0 = 从不；会话销毁时仍会回收）。只适用于 OMP 启动的无头标签页，绝不包括中继/CDP/派生的浏览器或其他会话的标签页。',
  'browser.screenshotDir':
    '保存截图的目录。不设置时，截图存到临时文件。支持 ~。例如：~/Downloads、~/Desktop、/sdcard/Download（Android）',
  'tools.intentTracing': '要求 Agent 在执行每次工具调用前先说明意图',
  'tools.abortOnFabricatedResult':
    '使用带内工具调用时，模型在轮中途开始伪造工具结果就立刻叫停。关闭则让模型把话生成完，然后丢弃伪造出来的后续内容。',
  'tools.speculativeExecution.enabled':
    '启用可安全丢弃的第一段：通过直接 read 调用与嵌套 eval 完成的、经过校验的本地读取。网络请求、供应商补全与真实文件系统写入不在这个基线之内。',
  'tools.speculativeExecution.maxInFlight':
    '在转入正常派发之前，最多允许多少个经过校验的本地读取并发跑着。',
  'tools.maxTimeout': 'Agent 可为任意工具设置的最大超时秒数（0 = 不限制）',
  'async.enabled': '启用异步 bash 命令与后台任务执行',
  'tools.xdev':
    '把少用的（可发现的）工具挂到 xd:// 设备 URL 下，用 read/write 驱动，而不是每个请求都带上它们的 schema。显式工具清单里给了 read 却没给 write 的会话，会通过只支持 write 的设备传输来挂载设备（文件系统写入仍会被拒绝）。关闭后，所有已启用的工具都暴露在顶层。',
  'tools.xdevDocs':
    '选择哪些已挂载设备的文档与 schema 内联进系统提示词。Built-ins 让核心工具保持内联，MCP 与扩展工具仍按需加载。',
  'tools.xdevInlineDevices':
    '当 xd:// 提示词文档为 Built-ins Only 时，内联名字匹配这些 glob 模式的动态设备（例如 mcp__context_mode_*）。Catalog Only 会忽略此设置。',
  'mcp.enableProjectConfig': '从项目根目录加载 .mcp.json/mcp.json',
  'mcp.startupTimeoutMs': '等待这么久（毫秒）用于 MCP 工具的首次发现；0 表示一直等到连接稳定',
  'mcp.renderMarkdownResults': '把非 JSON 的 MCP 文本结果在对话里渲染成 Markdown',
  'mcp.notifications': '把 MCP 资源更新注入 Agent 对话',
  'mcp.notificationDebounceMs': 'MCP 资源更新注入对话之前的防抖窗口，单位毫秒',
  'providers.autoThinkingMaxEffort':
    'auto 分类器最高能判到哪个档位。xhigh 让分类器最高只到顶端下面一档，只有显式写 ultrathink 才会上到 max；max 则允许分类器认为某一轮特别出色时，在支持顶档的模型上用满顶级档位。',
  'extensionHandlers.toolCallTimeoutMs':
    '扩展工具调用处理器的正有限活跃工作时长超时；无效值按 30000ms 处理，等待 OMP 自有对话框的时间不计入',
  'dev.autoqa':
    '自动上报工具问题（xd://report_issue）。默认开启；第一次上报会征求同意，拒绝后停止上报，直到显式重新启用',
  'dev.autoqaPush.endpoint':
    '接收自动 QA JSON 报告的完整 URL（默认 https://qa.omp.sh/v1/grievances）',

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

  // ── providers ───────────────────────────────────────────────────────────
  'providers.maxInFlightRequests':
    '每个供应商 id（例如 "openai" 或 "anthropic"）的最大并发 LLM 请求数，在共用同一配置根的所有本地 OMP 进程间共享。未列出的供应商不限并发。',
  'providers.openai-codex.codeMode':
    '让 Codex code_mode_only 模型（GPT-5.6）经 eval 运行。直连工具是 eval、ask、todo、yield、think、checkpoint 与 rewind；其余会话工具请用 eval cell。对应 codex-rs 的 Code Mode。auto 跟随模型目录里的标记。',
  'providers.openai-codex.codeModeDirectTools':
    'Codex Code Mode 的额外直连工具。标准直连工具是 eval、ask、todo、yield、think、checkpoint 与 rewind。',
  'secrets.enabled': '把已配置的密钥混淆，并对凭据形态的 token 做脱敏，然后再发给 AI 供应商',
  'providers.ollama-cloud.maxConcurrency':
    '每个进程内 Ollama Cloud 子代理运行的最大并发数；0 关闭这项供应商专属限制',
  'providers.webSearchTimeoutSeconds':
    '各供应商搜索传输的硬性超时秒数，超时后 web_search 改用下一个回退（上限 300）',
  'providers.antigravityEndpoint':
    'google-antigravity 供应商的端点路由策略（chat、search、image、discovery）',
  'providers.fireworksTier':
    'Fireworks 请求的承载通道。Priority 会带上 `service_tier: "priority"`，在高峰期以更高价格换取更高可靠性；Standard 不带该字段。Fast（`-fast`）模型忽略此项 —— Fast 自有一条承载通道。',
  'tts.localVoice': '本地 TTS 后端使用的 Kokoro 音色（美式/英式，女声/男声）',
  'providers.tinyModelDevice':
    '本地微型模型（标题 + 记忆）的推理后端：一个 ONNX 执行提供程序，或用 `mlx` 下载 MLX 权重并在 Apple 芯片上通过 mlx-lm 运行。默认只用 CPU 的 ONNX。环境变量 PI_TINY_DEVICE 会覆盖此项。',
  'providers.tinyModelDtype':
    '本地微型模型的 ONNX 量化/精度。默认沿用各模型自带的精度（q4）；精度越低越快，越高越保真。MLX 后端忽略此项（它的仓库是预先量化好的 4-bit）。环境变量 PI_TINY_DTYPE 会覆盖此项。',
  'providers.kimiApiFormat': 'Kimi Code 供应商的 API 格式（auto 跟随实时的模型元数据）',
  'providers.openaiWebsockets':
    'OpenAI Codex 模型的 Websocket 策略（auto 使用模型默认，on 强制启用，off 关闭）',
  'providers.cacheRetention':
    '转发给支持 prompt 缓存的供应商的缓存保留策略（Anthropic、Bedrock、OpenRouter、OpenAI）',
  'providers.streamFirstEventTimeoutSeconds':
    '等待模型流第一个事件的秒数；-1 使用供应商/环境变量的默认值，0 关闭该看门狗',
  'providers.streamIdleTimeoutSeconds':
    '模型流在两个事件之间允许沉默的秒数；-1 使用供应商/环境变量的默认值，0 关闭该看门狗',
  'providers.openrouterVariant':
    '追加到 OpenRouter 模型 ID 的默认路由变体后缀（若选择器里已指明变体则不再追加）',
  'providers.fetch': 'fetch/读取 URL 工具的读取后端优先级',
  'codexResets.autoRedeem':
    '自动花掉已存下的 Codex 速率限制重置：当某一轮卡住且没有其他账号能接手时，恢复一个因 5 小时窗口或周窗口耗尽而被阻塞的账号；同时抢救即将过期的额度。unset 会在第一次花费前询问，yes 直接花掉不再提示，no 关闭这两项检查。',
  'codexResets.minBlockedMinutes':
    '仅当自然解封时间 —— 已耗尽的 5 小时/周窗口中最近的那次重置 —— 还至少隔着这么多分钟时才自动使用（不为等一小会儿就花掉稀缺的重置）。把它调高（例如 360）即可忽略只涉及 5 小时窗口的阻塞。',
  'codexResets.keepCredits':
    '已存重置数低于此值时绝不自动花费（0 = 最后一个重置也可以被自动花掉）。即将过期的重置不受此限 —— 一个保留着却过期的重置什么也没保住。',
  'codexResets.salvageHorizonHours':
    '当某个已存的 Codex 重置将在这么多小时内过期，且 5 小时或周窗口中至少有一个还有可观用量可恢复时，自动花掉它（0 关闭过期抢救）。',
  'claudeResets.autoRedeem':
    '自动花掉可用的 Claude Cedar 或 Juniper 重置。Cedar 只用于其覆盖范围内的限制；Juniper 只能恢复单独的 5 小时阻塞。unset 会在第一次花费前询问，yes 直接花掉不再提示，no 同时关闭阻塞恢复与过期抢救。',
  'claudeResets.minBlockedMinutes':
    '仅当自然解封时间 —— 已耗尽的受覆盖窗口中最近的那次重置 —— 还至少隔着这么多分钟时才自动使用。只覆盖 5 小时的重置绝不用于周窗口或模型范围的阻塞。',
  'claudeResets.keepCredits':
    '至少保留这么多个 Claude 重置不花（0 表示最后一个可用重置也可以被自动花掉）。该保留量同样适用于过期抢救。',
  'claudeResets.salvageHorizonHours':
    '仅当服务器选定的 Cedar 重置所覆盖的窗口还有可观用量可恢复，且该授予允许提前使用或某个覆盖窗口已耗尽时，才在它临近过期（这么多小时内）时使用（0 关闭抢救）。',
  'provider.appendOnlyContext':
    '缓存系统提示词与工具描述，并维护一份只追加的消息日志，让供应商的前缀缓存（DeepSeek、Xiaomi/SGLang、Anthropic）以最高命中率生效。对已知支持前缀缓存的供应商会自动启用。',
  'exa.enabled': '启用 Exa 网页搜索供应商',
  'exa.searchDelayMs': 'Exa 网页搜索请求之间的最小间隔毫秒数；设为 0 关闭节流',
  'searxng.endpoint': '自托管 SearXNG 实例的基础 URL，用于网页搜索',

  // ── interaction ─────────────────────────────────────────────────────────
  'power.sleepPrevention':
    '会话活跃期间阻止系统休眠。各档位是累加的 —— 更高档会叠加所有更低档的抑制标志。',
  steeringMode: 'agent 正在工作时，如何处理排队中的消息',
  followUpMode: '一轮结束后如何取用追问消息',
  interruptMode: '插话消息何时打断工具执行',
  'magicKeywords.enabled':
    '为独立出现的关键词 ultrathink、orchestrate、workflowz、jevify 启用隐藏提示',
  'magicKeywords.ultrathink': '让独立出现的 ultrathink 请求最高自动思考档位，并附上其隐藏提示',
  'magicKeywords.orchestrate': '让独立出现的 orchestrate 附上其隐藏的多 agent 编排提示',
  'magicKeywords.workflow': '让独立出现的 workflowz 附上其隐藏的 eval 工作流提示',
  'magicKeywords.jevify': '让独立出现的 jevify 附上其隐藏的批量判定分类提示',
  'ask.timeout': '这么多秒后自动选择 ask 推荐的选项（0 关闭）',
  'ask.notify': 'ask 工具在等待输入时发出通知',
  'collab.relayUrl': '/collab 使用的中继（wss://host[:port]）',
  'collab.webUrl':
    '/collab 链接使用的浏览器界面；留空则从 collab.relayUrl 推导；显式的 http:// 仅限本机',
  'collab.displayName': '展示给其他协作参与者的名称（默认：操作系统用户名）',
  'collab.autoStart':
    '每个交互式会话启动时都经 collab.relayUrl 建立主机并发布到本地注册表（omp collab list）；切换会话时房间随之轮换',
  'share.serverUrl':
    '/share 使用的查看/上传基础地址（加密 blob 上传 + 查看器；链接形如 <base>/<id>#<key>）',
  'share.store': '/share 把加密的会话 blob 上传到哪里',
  'share.redactSecrets': '上传前先对 /share 快照跑一遍密钥混淆（使用 secrets.* 配置）',
  'stream.serverUrl':
    '`omp stream` 使用的直播服务器（https://host[:port]）；观众在 <base>/<你的 Stencil 用户名> 观看',
  'skills.registryUrl':
    '`omp skill` 用来安装、搜索与发布技能的 Skillshare 仓库（https://host[:port]）',
  'stt.submitTrigger':
    '选择语音听写何时自动发送：从不、松开即发送（2 个词以上）、松开且句子完整时发送，或当我说「发送」时发送。',
  'features.unexpectedStopDetection':
    '助手未给出可见消息就停止时自动恢复。Smart 还会用小模型对纯文本的停止做分类。',
  'tools.approval':
    '逐工具的审批策略。设为 allow 自动批准，prompt 需要确认，deny 直接阻止。任何审批模式下都会尊重这些覆盖设置。',
  'tools.approvalMode':
    '工具调用的默认审批行为。Always ask 只自动批准只读工具；Write 自动批准读取与工作区写入类工具；Yolo 自动批准所有层级；用户策略仍可能要求确认或阻止。',

  // ── files ───────────────────────────────────────────────────────────────
  'edit.mode': '选择 edit 工具的形态（replace、patch、hashline 或 apply_patch）',
  'edit.fuzzyMatch': '对仅有空白差异的情况接受高置信度的模糊匹配',
  'edit.fuzzyThreshold': '接受模糊匹配的相似度阈值（0-1）',
  'edit.streamingAbort': '补丁预览失败时中止流式中的 edit 工具调用',
  'edit.recoverInlineEdits': '把模型以纯文本形式吐出的 edit 载荷转成 edit 工具调用并执行',
  'edit.blockAutoGenerated': '阻止编辑看起来是自动生成的文件（protoc、sqlc、swagger 等）',
  'edit.enforceSeenLines': '拒绝锚定在先前的读取/搜索从未完整显示过的行上的编辑',
  'edit.blackbox.enabled': '某次编辑引入 AST 解析失败时，追加完整的修改前后源码',
  'edit.autoRepair.enabled':
    '某次编辑破坏了文件的 AST 解析时，让 smol 模型修复出问题的区域（通过重新解析校验；失败则退化为一条警告）',
  readLineNumbers: '默认在 read 工具的输出前加上行号',
  'read.defaultLimit': 'agent 调用 read 时未给 limit，默认返回的行数',
  'read.renderMarkdown': '把 Markdown 读取结果渲染成排好版的终端 Markdown 预览，而不是原始源码',
  'read.summarize.enabled': 'read 未指定显式选择器时，返回结构化的代码摘要',
  'read.summarize.prose': '对 Markdown 与纯文本的读取也返回结构化摘要',
  'read.summarize.minBodyLines': '多行正文或字面量达到多少行才被读取摘要折叠',
  'read.summarize.minCommentLines': '多行块注释达到多少行才被读取摘要折叠',
  'read.summarize.minTotalLines': '总行数少于该值的文件按原样读取，不做结构化摘要',
  'read.summarize.unfoldUntil':
    '对可省略的区段做 BFS 展开，直到摘要至少有这么多可见行。0 表示只保留最外层的省略。',
  'read.summarize.unfoldLimit':
    'BFS 展开时摘要大小的硬上限。若展开后揭示的行数会超过该上限则跳过这次展开（该区段保持折叠），并继续展开其余区段。',
  'read.toolResultPreview': '在对话记录里内联渲染 read 工具的结果，而不是只显示摘要行',
  'lsp.enabled': '启用 lsp 工具以获取代码智能（定义、引用、诊断、重命名）',
  'lsp.lazy': '语言服务器在首次使用时才启动（调用 lsp 工具或编辑匹配的文件类型），而不是会话启动时',
  'lsp.shared':
    '经 daemon broker 在各 omp 实例间共用每个项目的一个语言服务器（不可用时回退为私有服务器）',
  'lsp.formatOnWrite': '写入后自动用 LSP 格式化代码文件',
  'lsp.diagnosticsOnWrite': '写入代码文件后返回 LSP 诊断',
  'lsp.diagnosticsOnEdit': '编辑代码文件后返回 LSP 诊断',
  'lsp.diagnosticsDeduplicate': '抑制某个文件已经展示过的编辑后 LSP 诊断；只呈现新增或有变化的诊断',

  // ── shell ───────────────────────────────────────────────────────────────
  'bash.enabled': '启用 bash 工具以执行 shell 命令',
  'bash.allowCompoundCommands':
    '把字面量 && 链按单条命令逐一评估；未匹配的命令走常规的 bash 审批策略与模式',
  'bash.autoBackground.enabled': '自动把长时间运行的 bash 命令转为后台，稍后再交付结果',
  'bash.patterns': '有序的 bash 命令审批规则。每项含 match 与 approval 字段；仅支持 * 通配符。',
  'bashInterceptor.enabled': '拦截那些已有专用工具的 shell 命令',
  'bash.direnv':
    '把仓库的 direnv/devenv `.envrc` 自动加载进 bash 会话，免去手动 `direnv exec` 就能用上 devenv 工具与环境变量。遵守 direnv 的允许清单：没有 `direnv allow` 过的 `.envrc` 绝不执行',
  'bash.direnvLoadTimeoutMs':
    '首次 `direnv export` 的最长等待（冷启动的 devenv shell 可能很慢）；超时后该会话在没有 direnv 环境的情况下运行',
  'shellMinimizer.enabled': '把冗长的 shell 输出（git、npm、cargo 等）压缩后再交回 agent',
  'shellMinimizer.sourceOutlineLevel':
    '对源文件执行 cat/read 时的源码大纲模式：default 或 aggressive',
  'eval.py': '允许 eval 工具把 Python cell 派发到 IPython 内核',
  'eval.js': '允许 eval 工具把 JavaScript cell 派发到进程内运行时',
  'eval.autoProvision': '首次安装时自动创建受管的 JavaScript eval 包环境',
  'eval.tools.enabled':
    '允许 eval cell 定义工具（Python 里的 @tool，JS 里的 tool(fn)），供 task、agent() 与 workpool() 子代理调用',
  'eval.workpool.freshAgents':
    '为 workpool 的每一项都新开一个子代理，而不是复用 worker 或把排队项凑批处理',
  'eval.autoBackground.enabled': '自动把长时间运行的 eval cell 转为后台，稍后再交付结果',
  'python.kernelMode': '让 IPython 内核在多次 eval 调用间保持存活，或每次都重新启动',
  'python.interpreter': '可选的精确 Python 可执行文件路径。设置后跳过 Python 运行时的自动探测。',
}

/**
 * 这一格的说明，中文优先。
 *
 * 认不出的 path 交回 `fallback`（omp 的英文原文），绝不返回空串 —— 空的说明比英文更坏：
 * 它让人以为这一格没有说明。
 */
export function settingDescriptionOf(path: string, fallback: string): string {
  return DESCRIPTIONS[path] ?? fallback
}

/** 这一格的说明有没有中文；界面据此决定要不要把英文原文摆在下面。 */
export function hasDescriptionTranslation(path: string): boolean {
  return path in DESCRIPTIONS
}

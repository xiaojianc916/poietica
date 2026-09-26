/*
 * omp 设置的中文说明（分片 a：model 与 tools 两栏共 113 格）。
 *
 * 键与 `settings-labels.ts` 一致，用 omp 自己的 **path**（不是英文 label）：
 * path 是稳定标识符，label 是会自动改词的散文。查不到就由调用方原样交出 omp 的
 * 英文说明 —— 表只可能少、不会错。
 *
 * 说明是给「决定要不要翻这个开关」的人读的，所以译的是行为而不是词；数字、单位、
 * `service_tier` 这类代码片段与 omp、MCP 这类产品/协议名一律原样保留。
 */

export const DESCRIPTIONS_A: Readonly<Record<string, string>> = {
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
}

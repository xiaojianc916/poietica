/*
 * omp 设置的**说明文字**中文表 —— 分片 c。
 *
 * 与 settings-labels.ts 同构：键是 omp 的 **path**，值是这一格说明的中文。
 * 分片只为并行翻译切开，语义上是一张表；由 settings-descriptions.ts 合并成一份。
 * 查不到就原样返回 omp 的英文说明（同 labels 的安全属性）：缺一条翻译只是不好看。
 */

export const DESCRIPTIONS_C: Readonly<Record<string, string>> = {
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

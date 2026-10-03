
// 生成物，禁手改：由 `bun run ipc:generate` 从 apps/desktop/native/src/ipc/mod.rs 导出。
//
// 命令名与参数名是线上形状，与 Rust 一字不差；类型定义在同一个文件的上半部分。

declare global {
  interface Window {
    /** preload 装的唯一入口。渲染层没有 require，也没有 ipcRenderer。 */
    poietica: {
      invoke(command: string, args: unknown): Promise<unknown>
      on(kind: string, handler: (payload: unknown) => void): () => void
    }
  }
}

async function call<T>(command: string, args: unknown): Promise<T> {
  return (await window.poietica.invoke(command, args)) as T
}

export type AgentAbortPromptRequest = { threadId: string; promptId: string }
export type AgentAnswerQuestionsRequest = { questionId: string; answers: AgentQuestionAnswer[]; method: AgentQuestionMethod | null; 
/**
 * wire 上合法的一格，但官方 server 收下之后不读它（routes/questions.ts 的 toInProcessResponse）；送它是因为契约里有它。
 */
note: string | null }
export type AgentApprovalDecision = "approved" | "rejected"
/**
 * kap 的 approvalScopeSchema 只有这一个取值。
 */
export type AgentApprovalScope = "session"
export type AgentArchiveThreadRequest = { threadId: string; archived: boolean }
/**
 * agent 的浏览器控制设置，原样投影。
 */
export type AgentBrowserSettings = { enabled: boolean; headless: boolean; 
/**
 * 驱动本机内置浏览器那一档；它优先于 cdp_url。
 */
relay: boolean; cdpUrl: string | null }
/**
 * 一次浏览器控制设置的改动；缺席的格不改。
 */
export type AgentBrowserSettingsPatch = { enabled: boolean | null; headless: boolean | null; relay: boolean | null; cdpUrl: string | null }
export type AgentCancelRequest = { threadId: string }
export type AgentCapabilitiesRequest = { cwd: string | null }
export type AgentCapability = { id: string; pluginId: string | null; label: string; supported: boolean; state: AgentCapabilityState; install: AgentCapabilityInstall }
/**
 * 后台安装进度，原样投影。
 */
export type AgentCapabilityInstall = { running: boolean; step: string | null; percent: number | null; error: string | null }
export type AgentCapabilityInstallRequest = { capabilityId: string; 
/**
 * 打开还是关上。omp 里这一项没有「安装」这一步，只有开关。
 */
enabled: boolean }
/**
 * agent 对一项能力的就绪裁决，原样投影。
 */
export type AgentCapabilityState = "notInstalled" | "partial" | "ready" | "unsupported"
export type AgentConfigChoice = { value: string; label: string; detail: string | null }
export type AgentConfigControl = { id: string; label: string; detail: string | null; purpose: AgentConfigPurpose; appliesOnSubmit: boolean; current: string; choices: AgentConfigChoice[] }
export type AgentConfigPurpose = "permission" | "mode" | "model" | "thought" | "other"
export type AgentConfigSnapshot = { 
/**
 * 磁盘上那一份接入档案；还没写过时是 null。
 */
profile: JsonValue | null; issues: string[] }
/**
 * 这句话怎么交给 agent：omp 的三层插话，打断程度递减。
 * 
 * 与 packages/agent-bridge/src/protocol.ts 的 `deliverAs` 以及
 * crates/conversation 的 `DeliverAs` 三处同名同值，判别式只在各自的边界上翻一次。
 */
export type AgentDeliverAs = 
/**
 * 开一轮（空闲时的正常发送）。
 */
"turn" | 
/**
 * 插进正在跑的那一轮：在工具批次之间被模型看到。
 */
"steer" | 
/**
 * 不打断：这一轮跑完后自动作为下一轮输入。
 */
"followUp"
/**
 * 改队列模式；缺席的格不改。
 */
export type AgentDeliveryModesRequest = { steeringMode?: string | null; followUpMode?: string | null; interruptMode?: string | null }
export type AgentDismissQuestionsRequest = { questionId: string }
export type AgentExportThreadRequest = { threadId: string; 
/**
 * 导出落点。由宿主的保存对话框给出 —— 原生侧没有窗口，开不出对话框。
 * `None` 就是用户在对话框里按了取消。
 */
destination: string | null }
export type AgentForkThreadRequest = { threadId: string; title: string; 
/**
 * 分叉点：这一轮之后还有几轮，0 就是从最后一轮分叉；agent 侧回退上下文与本机日志截断用同一个数，屏幕与上下文止于同一处。
 */
dropTurns: number; cwd: string | null }
export type AgentGoal = { objective: string; completionCriterion: string | null; status: string; turnsUsed: number; tokensUsed: number; wallClockMs: number }
/**
 * Fresh 是本来就没有经过；Loaded 是这次把已有会话重装了回来。
 */
export type AgentHistory = { state: "fresh" } | { state: "loaded" }
export type AgentMcpServer = { id: string; name: string; status: AgentMcpStatus; toolCount: number; lastError: string | null }
export type AgentMcpStatus = "connected" | "connecting" | "disconnected" | "error"
export type AgentModelCatalogRequest = { cwd: string | null; operation: ModelCatalogOperationDto }
export type AgentOpenThreadRequest = { target: AgentThreadTarget; cwd: string | null }
export type AgentOpenedThread = { thread: AgentThread; selectors: AgentConfigControl[]; goal: AgentGoal | null; history: AgentHistory; transcript: AgentTranscriptJson }
export type AgentPinThreadRequest = { threadId: string; pinned: boolean }
export type AgentPromptAsset = { sessionToken: string; assetToken: string; filename: string; 
/**
 * Image 走内存注册表；File 是暂存在磁盘上的通用文件。
 */
kind: AssetKind }
export type AgentPromptConfiguration = { id: string; value: string }
/**
 * A prompt, and how to start the agent if it is not running yet.
 */
export type AgentPromptRequest = { text: string; 
/**
 * 这一句走哪一层。缺席即开一轮：老调用方（自动化、恢复）不传这一格。
 */
deliverAs?: AgentDeliverAs; configuration: AgentPromptConfiguration[]; 
/**
 * 与 text 是同一句话的两半：只挑了图、没打字也是一句完整的话，判空要一起判。
 */
assets: AgentPromptAsset[]; skills: AgentPromptSkill[]; threadId: string | null; cwd: string | null }
export type AgentPromptResult = { sessionId: string; promptId: string }
export type AgentPromptSkill = { name: string; args: string | null }
export type AgentQuestionAnswer = { questionId: string; answer: AgentQuestionChoice }
/**
 * 与 kap 的 questionAnswerSchema 逐一对应，判别式与分支名逐字相同，不摊平。
 */
export type AgentQuestionChoice = { kind: "single"; optionId: string } | { kind: "multi"; optionIds: string[] } | { kind: "other"; text: string } | { kind: "multi_with_other"; optionIds: string[]; otherText: string } | { kind: "skipped" }
/**
 * 取值即 kap 的 questionAnswerMethodSchema；官方把 click 丢掉，仍如实上报。
 */
export type AgentQuestionMethod = "enter" | "space" | "number_key" | "click"
/**
 * 待发队列此刻的样子：两层正文 + 三个模式。
 * 
 * 队列的真相在 agent 里，这一层只搬。`steering` 与 `followUp` 都是已经交给 agent 的
 * 用户消息正文；上游的第三档 `aside` 不在其中（见 ADR 0034）。
 */
export type AgentQueuedState = { sessionId: string; steering: string[]; followUp: string[]; steeringMode: string; followUpMode: string; interruptMode: string }
export type AgentRenameThreadRequest = { threadId: string; title: string }
export type AgentResolvePermissionRequest = { requestId: string; decision: AgentApprovalDecision; scope: AgentApprovalScope | null; selectedLabel: string | null; feedback: string | null }
export type AgentSelectConfigRequest = { threadId: string | null; configId: string; value: string; input: string | null }
export type AgentSessionEvent = { kind: "selectors"; sessionId: string; selectors: AgentConfigControl[]; goal: AgentGoal | null } | { kind: "usage"; sessionId: string; usage: AgentSessionUsage } | 
/**
 * provider、模型或默认模型的真身以它为准：收到即作废缓存重问。
 */
{ kind: "modelCatalogChanged" } | 
/**
 * 待发队列变了：谁排了一句、谁撤回了一句、模型在哪一刻真的看见了它。
 * 
 * 队列的真相在 agent 里。这条只把此刻的样子推出去，`agent_queue` 是同一份事实的
 * 另一个出口（断线重连、刚打开一条对话时读它）。
 */
{ kind: "queue"; sessionId: string; queue: AgentQueuedState } | 
/**
 * 这一句在入队前就被取消了（abort 或用量预检竞态），**没有落进会话文件**。
 * 
 * 收到它就要把屏幕上那条乐观记录收成失败：上游不会为它发任何 transcript 帧
 * （它压根没进会话）。正文仍可由失败横幅取回输入框。
 */
{ kind: "promptDropped"; sessionId: string; text: string } | 
/**
 * agent 要问一个对话框（confirm / input / editor）。
 * 
 * `request` 是 agent 自己那份形状，原样转发 —— 本层不认识它，也不该认识。
 * 授权那一类不走这里（它走 permission_requested 那帧）；ask 工具的题组也不走
 * 这里（它走 questions_asked，产品形状，由提问桌收答复）。
 */
{ kind: "dialog"; sessionId: string; request: JsonValue }
/**
 * 取一张 agent 会话媒体（历史图片）：webview 无法带 Bearer 直连，原生侧代取回 base64。
 */
export type AgentSessionMediaRequest = { sessionId: string; fileId: string }
export type AgentSessionMediaResult = { contentType: string; base64: string }
/**
 * kap 的 agent.status.updated 报的是仪表值：到达即替换，不是增量；按读数算增量的是账本。
 */
export type AgentSessionUsage = { used: number; size: number; inputOther: number; inputCacheRead: number; inputCacheCreation: number; 
/**
 * 此刻这份上下文的构成。缺席即这一份报数没带构成：屏幕退成只画总条。
 */
breakdown: AgentUsageBreakdown | null }
/**
 * 目录里的一格设置。
 * 
 * **手写 Debug**：`default` 与 `value` 是设置载荷，钥匙那一格的值就在其中
 * （AGENTS.md §5「Debug 不打载荷」）。这里只打非载荷的标识。
 */
export type AgentSettingEntry = { path: string; 
/**
 * agent 自己那份 schema 的类型词：boolean / enum / number / string / array / record。
 */
type: string; label: string; description: string; group: string | null; 
/**
 * 未设置时生效的值。
 */
default: JsonValue; 
/**
 * 此刻生效的值；`secret` 为真时恒为 null。
 */
value: JsonValue; secret: boolean; hasValue: boolean; 
/**
 * 枚举那张选项表；空即这一格没有固定选项。
 */
options: AgentSettingOption[] | null; 
/**
 * 没有 options 时的取值域。
 */
enumValues: string[] | null; warning: string | null; condition: string | null; 
/**
 * 所在分节的中文名；分组仍然按 `group`（agent 自己的词）分。
 */
groupLabel: string | null; 
/**
 * 这一格的**行**由产品别处的控件负责；值仍然报（别的格子按它决定显不显示）。
 */
owned: boolean; 
/**
 * 归产品哪一个剥离页画（`memory` / `persona`）；缺席即不属于任何一页。
 * 与 `owned` 正交：一格可以既有归属又 owned，那一页也不画它的行。
 */
section: string | null }
/**
 * 枚举/子菜单的一张选项表；原样投影。
 */
export type AgentSettingOption = { value: string; label: string; description: string | null }
/**
 * 改一格设置。`value` 的类型由 agent 自己的 schema 说了算，本层不折算。
 */
export type AgentSettingWriteRequest = { path: string; value: JsonValue }
/**
 * 一整份目录：栏里的格子。
 */
export type AgentSettingsCatalog = { settings: AgentSettingEntry[] }
export type AgentShareThreadRequest = { threadId: string }
/**
 * 一次分享的结果。
 * 
 * 只有两格。`url` 是给人点的那一条链接 —— **它同时是读取凭据**（omp 的形状是
 * `<serverUrl>/<id>#<key>`，`#` 之后是解密密钥），所以它只往界面上走，不进日志、
 * 不进错误文案（`ShareOutcome` 的手写 Debug 就是这条纪律的落点）。
 * 
 * `truncated` 如实来自 agent：为真表示内容为塞进上传预算被裁过。绝不替它猜一个
 * false —— 那等于替 agent 断言「内容是完整的」。
 */
export type AgentSharedThread = { url: string; truncated: boolean }
export type AgentSkill = { id: string; name: string; description: string; source: string; path: string; project: string | null; projectPath: string | null; document: string | null; directory: string | null; enabled: boolean; loaded: boolean; kind: string | null; disableModelInvocation: boolean | null; supportingFiles: number | null; totalBytes: number | null; modifiedAt: number | null }
export type AgentThread = { threadId: string; sessionId: string | null; title: string; titleSource: AgentTitleSource; updatedAt: string; pinned: boolean; 
/**
 * 它是在哪个工作目录里开的；空表示默认那一个工作区。
 */
workspaceRoot: string | null; archived: boolean }
export type AgentThreadRequest = { threadId: string }
export type AgentThreadSnapshot = { thread: AgentThread; usage: AgentSessionUsage | null }
export type AgentThreadTarget = { kind: "create"; threadId: string } | { kind: "existing"; threadId: string }
/**
 * 界面按它排序：用户手打的名字永不被派生名替换。
 */
export type AgentTitleSource = "message" | "generated" | "fallback" | "manual"
export type AgentToolkit = { skills: AgentSkill[]; mcpServers: AgentMcpServer[] }
export type AgentToolkitRequest = { cwd: string | null; threadId: string | null }
export type AgentTranscriptEvent = { sessionId: string; json: JsonValue }
export type AgentTranscriptJson = { json: JsonValue }
export type AgentTranscriptOpsRequest = { sessionId: string; agentId: string; sinceSeq: number }
/**
 * 载荷以 JSON 文本透传：契约钉在 vendored @poietica/transcript 的 schema，这里不重抄第二份形状。
 */
export type AgentTranscriptRequest = { sessionId: string; agentId: string; beforeTurn: string | null }
/**
 * 上下文构成，与 agent 状态行里显示的那份逐格对应。
 */
export type AgentUsageBreakdown = { systemPrompt: number; systemContext: number; systemTools: number; skills: number; messages: number; free: number; autoCompactBuffer: number }
/**
 * 撤回交回来的那一句；空队列时整格是 null。
 */
export type AgentWithdrawnMessage = { text: string }
export type AppSettings = { theme: ThemePreference; language: string; general: GeneralSettings; appearance: AppearanceSettings; modelPicker: ModelPickerSettings; privacy: PrivacySettings }
export type AppearanceSettings = { density: Density; reduceMotion: boolean; messageTimestamps: boolean }
export type AssetImportRequest = { sessionToken: string; paths: string[] }
export type AssetKind = "image" | "file"
export type AssetReadRequest = { sessionToken: string; assetToken: string; 
/**
 * 只要这一段字节；缺席即整份。
 * 
 * 视频与音频的 seek 与缩略图都走 HTTP Range，而注册表里那份是整份 —— 不在这里切，
 * 就得把整份（上限 32 MiB）base64 过两遍 IPC，只为拿开头 1 KiB（实测 4 MiB 资产
 * 取 1 KiB 要 147 ms，取整份才 180 ms）。
 */
offset: number | null; length: number | null }
/**
 * 一次读回的字节。
 * 
 * 图片在被投递之前**只在内存注册表里**（进门不落盘，发送时才搬进附件根），
 * 所以宿主按磁盘路径找不到它。字节因此经这里交给主进程，由它按协议应答
 * （见 apps/desktop/electron/asset-protocol.ts）。
 */
export type AssetReadResult = { contentType: string; 
/**
 * 这一段自己的长度，不是整份的。
 */
byteLength: number; 
/**
 * 整份资产的长度：Range 应答要拿它拼 `content-range: bytes a-b/total`。
 */
totalLength: number; 
/**
 * base64 原始字节，不带 `data:` 前缀；与 AssetUploadRequest 同一条线上形状的理由。
 */
base64: string }
export type AssetRemoveRequest = { sessionToken: string; assetToken: string }
export type AssetSessionResult = { sessionToken: string }
export type AssetUploadRequest = { sessionToken: string; 
/**
 * base64 原始字节，不带 `data:` 前缀；刻意不用 `Vec<u8>`：JSON 边界上它线上是 `number[]`，大四五倍。
 */
base64: string }
export type AssetUploadResult = { 
/**
 * Image：进内存注册表、source 是预览地址；File：落盘暂存、source 为空。
 */
kind: AssetKind; assetToken: string; contentHash: string; source: string; byteLength: number; contentType: string }
export type Automation = { id: string; title: string; prompt: string; schedule: string | null; enabled: boolean; createdAt: string; nextRunAt: string | null; sessionConfig: Partial<{ [key in string]: string }>; runs: AutomationRun[]; revision: number; workspaceRoot: string | null; timeZone: string; issue: string | null }
export type AutomationCatalog = { revision: number; automations: Automation[] }
export type AutomationCatalogChanged = { catalog: AutomationCatalog }
export type AutomationCreation = { title: string; prompt: string; schedule: string | null; sessionConfig: Partial<{ [key in string]: string }>; workspaceRoot: string; timeZone: string }
export type AutomationRun = { id: string; threadId: string | null; scheduledFor: string | null; startedAt: string; settledAt: string | null; outcome: AutomationRunOutcome; message: string | null }
export type AutomationRunOutcome = "queued" | "dispatching" | "running" | "cancelling" | "uncertain" | "succeeded" | "failed" | "cancelled"
export type AutomationUpdate = { id: string; expectedRevision: number; creation: AutomationCreation; enabled: boolean }
export type CatalogModelDto = { id: string; name: string | null; maxContextSize: number; capabilities: string[] | null; reasoning: boolean }
export type CatalogProviderDto = { id: string; name: string; wireType: string | null; guessed: boolean; needsBaseUrl: boolean; rejected: boolean; rejectReason: string | null; envKey: string | null; models: CatalogModelDto[] }
/**
 * 谁该负责。封闭九类，边界上不许另起分类。
 */
export type Category = "validation" | "configuration" | "permission" | "transport" | "protocol" | "persistence" | "integrity" | "cancelled" | "internal"
/**
 * 稳定错误码。一个码只对应一个原因；删码等于破坏契约。
 */
export type Code = "contractDecodeFailed" | "capabilityMissing" | "agentUnavailable" | "agentStartFailed" | "turnRejected" | "deliveryUnknown" | "permissionDenied" | "workspaceUnavailable" | "ledgerAppendFailed" | "ledgerCorrupted" | "cancelled" | "internal" | "requestInvalid" | "resourceMissing" | "fileUnavailable" | "settingsUnavailable" | "assetRejected" | "pluginRejected" | "agentRejected" | "gitRejected" | "hostFailed"
export type Density = "comfortable" | "compact"
/**
 * 一次失败的编号：日志、上报、界面引用同一个值。
 * 
 * v7 带时间前缀且单调，按字符串排序即按发生顺序，不必手写 ULID。
 */
export type DiagnosticId = string
export type EnvironmentFile = { location: string; contents: string | null }
export type ForeignPluginInventory = { location: string; plugins: ForeignPluginRecord[] }
/**
 * 用户在命令行装的插件，读自用户自家 home 的账；它们不参与受控会话，不得并进已安装列表。
 */
export type ForeignPluginRecord = { pluginId: string; originalSource: string | null }
export type GeneralSettings = { sendWithModifier: boolean; confirmBeforeDelete: boolean; notifyOnCompletion: boolean; 
/**
 * 守着本地 agent 进程的那一个意图。相位不在这里：它是进程内的事实，
 * 落盘只会得到一份开机就过期的记载。
 */
daemon: boolean }
/**
 * branch 为空即 HEAD 分离，detachedAt 给出所在短号。
 */
export type GitBranches = { branch: string | null; detachedAt: string | null; branches: string[] }
export type GitChangeStatus = "added" | "modified" | "deleted" | "untracked" | "conflicted"
export type GitCommitIntent = "commit" | "commit-and-push" | "push"
export type GitCommitRequest = { root: string; intent: GitCommitIntent; message: string; stageAll: boolean; base: string; context: number; ignoreWhitespace: boolean }
/**
 * path 是仓库根的相对路径。
 */
export type GitFileChange = { path: string; status: GitChangeStatus; staged: boolean }
export type GitReview = { branch: string | null; detachedAt: string | null; upstream: string | null; ahead: number; behind: number; branches: string[]; changes: GitFileChange[]; patch: string }
export type GitWatchLease = { token: string; root: string }
export type GitWorkingTreeChanged = { root: string }
export type JsonValue = null | boolean | number | string | JsonValue[] | Partial<{ [key in string]: JsonValue }>
export type McpLauncher = { program: string; prefixArgs: string[] }
/**
 * 一次目录操作。判别式与 @poietica/settings 的 ModelCatalogOperation 一一对应。
 */
export type ModelCatalogOperationDto = { kind: "snapshot" } | { kind: "refreshProviders" } | { kind: "create"; provider: ProviderInputDto } | { kind: "replace"; providerId: string; provider: ProviderReplacementDto } | { kind: "delete"; providerId: string } | { kind: "importCatalog"; catalogId: string; apiKey: string | null; baseUrl: string | null; id: string | null } | { kind: "setDefault"; modelId: string }
export type ModelCatalogSnapshotDto = { providers: ProviderDto[]; models: ModelDto[]; catalog: CatalogProviderDto[]; defaultModel: string | null }
export type ModelDto = { provider: string; model: string; displayName: string | null; maxContextSize: number; capabilities: string[] | null; maxOutputSize: number | null; supportEfforts: string[] | null; adaptiveThinking: boolean | null; defaultEffort: string | null }
export type ModelPickerSettings = { hiddenModelAliases: string[]; providerOrder: string[] }
export type PluginCommitRequest = { stagingId: string; pluginId: string; subdirectory: string | null; source: string; originalSource: string | null; installedAt: string }
export type PluginFetch = { kind: "directory"; path: string } | { kind: "archive"; url: string; subdirectory: string | null }
/**
 * 清单读不出时 manifest_json 是空串，这一条仍要交出：坏插件也必须在界面占一行。
 */
export type PluginPayload = { pluginId: string; manifestJson: string; enabled: boolean; installedAt: string | null; source: string; originalSource: string | null; disabledMcpServers: string[] }
export type PluginStaged = { stagingId: string; manifestJson: string }
export type PrivacySettings = { telemetry: boolean; crashReporting: boolean; updateCheck: boolean }
/**
 * 唯一允许跨越进程与语言边界的错误形状。
 */
export type Problem = { code: Code; category: Category; retryability: Retryability; 
/**
 * 文案键，不是句子：文案归前端目录。
 */
userMessageKey: string; diagnosticId: DiagnosticId; details: Partial<{ [key in string]: string }> }
export type ProviderDto = { id: string; providerType: string; baseUrl: string | null; defaultModel: string | null; hasApiKey: boolean; status: string; models: string[] | null }
export type ProviderInputDto = { id: string; providerType: string; apiKey: string | null; baseUrl: string | null; defaultModel: string | null; models: ProviderModelInputDto[] }
export type ProviderModelInputDto = { model: string; maxContextSize: number; displayName: string | null; capabilities: string[] | null; maxOutputSize: number | null; supportEfforts: string[] | null; adaptiveThinking: boolean | null }
export type ProviderReplacementDto = { newId: string | null; providerType: string; apiKey: string | null; baseUrl: string | null; defaultModel: string | null; models: ProviderModelInputDto[] }
/**
 * 后台装机进度。
 * 
 * percent 恒为 null：字节数不出 crate（那边是它自己的一条流），这里不编造百分比 ——
 * 界面据此画不确定进度条，比一个匀速前进的假数字诚实。
 */
export type PythonKernelInstall = { running: boolean; step: string | null; percent: number | null; error: string | null }
/**
 * 界面那一格此刻是什么状态：盘上那份安装，外加宿主自己手上那份活。
 * 
 * `Installing` 只由**正在跑的装机**产生，不是从盘上推出来的：盘上认得出「装好了」
 * 与「装坏了」，认不出「正在装」—— 那是进程内的事实（见 `INSTALL`）。
 */
export type PythonKernelState = "notInstalled" | "installing" | "ready" | "broken" | "unsupported"
export type PythonKernelStatus = { state: PythonKernelState; 
/**
 * 只有装好才报版本：一棵坏树上挂个版本号是假消息。
 */
version: string | null; 
/**
 * 受管目录；目录在就报，界面据此提供「打开所在位置」。
 */
path: string | null; 
/**
 * 要写进设置的那个解释器路径；与 ready 同进同退。
 */
interpreter: string | null; install: PythonKernelInstall }
/**
 * 能不能再来一次，以及由谁发起。
 */
export type Retryability = "no" | "afterDelay" | "afterUserAction"
export type SchedulePreview = { nextRunAt: string | null; problem: ScheduleProblem | null }
export type ScheduleProblem = "unreadable" | "neverRuns" | "tooFrequent" | "timeZone"
export type SettingsWriteResult = { settings: AppSettings; applicationProblem: Problem | null }
export type SkillCommitRequest = { stagingId: string; name: string; subdirectory: string | null }
export type SkillRecord = { name: string; enabled: boolean; document: string; path: string; supportingFiles: number; totalBytes: number; modifiedAt: number | null }
export type SkillStaged = { stagingId: string; skillMd: string }
export type TerminalChunk = { kind: "output"; value: string } | { kind: "exited" }
export type TerminalStreamed = { root: string; chunk: TerminalChunk }
export type ThemePreference = "light" | "dark" | "system"
export type UsageDay = { day: string; tokens: number }
/**
 * 一天里一个模型花掉的 token。趋势图按它分线。
 */
export type UsageModelDay = { day: string; model: string; tokens: number }
export const commands = {
/**
 *  Returns the agent's submission receipt without waiting for model completion.
 * 
 *  `deliverAs` 决定这句话走哪一层：`turn` 开一轮（回执带轮身份），三层插话不开轮
 *  （回执只是「agent 收下了」—— 上游的 steer/followUp 都返回 void，队列归它）。 */
  async agentPrompt(request: AgentPromptRequest): Promise<AgentPromptResult> {
    return call<AgentPromptResult>('agent_prompt', { request: request })
  },
  async agentCancel(request: AgentCancelRequest): Promise<null> {
    return call<null>('agent_cancel', { request: request })
  },
/**
 *  待发队列此刻的样子。队列的真相在 agent 里，这条只是读回来。 */
  async agentQueue(): Promise<AgentQueuedState> {
    return call<AgentQueuedState>('agent_queue', {})
  },
/**
 *  撤回最后一条还排着的插话（LIFO）；队列空着回 null，不是错。 */
  async agentWithdraw(): Promise<AgentWithdrawnMessage | null> {
    return call<AgentWithdrawnMessage | null>('agent_withdraw', {})
  },
/**
 *  改队列模式；应答是改完之后那一份队列。 */
  async agentSetDeliveryModes(request: AgentDeliveryModesRequest): Promise<AgentQueuedState> {
    return call<AgentQueuedState>('agent_set_delivery_modes', { request: request })
  },
  async agentAbortPrompt(request: AgentAbortPromptRequest): Promise<null> {
    return call<null>('agent_abort_prompt', { request: request })
  },
  async agentResolvePermission(request: AgentResolvePermissionRequest): Promise<null> {
    return call<null>('agent_resolve_permission', { request: request })
  },
  async agentAnswerQuestions(request: AgentAnswerQuestionsRequest): Promise<null> {
    return call<null>('agent_answer_questions', { request: request })
  },
  async agentDismissQuestions(request: AgentDismissQuestionsRequest): Promise<null> {
    return call<null>('agent_dismiss_questions', { request: request })
  },
  async agentSetConfigOption(request: AgentSelectConfigRequest): Promise<AgentConfigControl[]> {
    return call<AgentConfigControl[]>('agent_set_config_option', { request: request })
  },
/**
 *  Reads the anchor without creating a conversation. */
  async agentCapabilities(request: AgentCapabilitiesRequest): Promise<AgentConfigControl[]> {
    return call<AgentConfigControl[]>('agent_capabilities', { request: request })
  },
  async agentToolkit(request: AgentToolkitRequest): Promise<AgentToolkit> {
    return call<AgentToolkit>('agent_toolkit', { request: request })
  },
/**
 *  读或改这个 agent 的模型目录。写操作执行完，回答的仍是改后的整份快照。 */
  async agentModelCatalog(request: AgentModelCatalogRequest): Promise<ModelCatalogSnapshotDto> {
    return call<ModelCatalogSnapshotDto>('agent_model_catalog', { request: request })
  },
/**
 *  读取 agent 的应用级能力清单；连接不存在时按统一启动管线建立。 */
  async agentCapabilityReport(): Promise<AgentCapability[]> {
    return call<AgentCapability[]>('agent_capability_report', {})
  },
/**
 *  开关一项本机能力，交回改完之后的整份清单。
 * 
 *  与 `agent_capability_report` 同形：omp 里这一项没有安装这一步，一次开关改的是
 *  一个设置，清单里别的项也可能跟着变 —— 只回被点的那一项就是让调用方去猜。 */
  async agentCapabilityInstall(request: AgentCapabilityInstallRequest): Promise<AgentCapability[]> {
    return call<AgentCapability[]>('agent_capability_install', { request: request })
  },
/**
 *  读取 agent 的浏览器控制设置；连接不存在时按统一启动管线建立。 */
  async agentBrowserSettings(): Promise<AgentBrowserSettings> {
    return call<AgentBrowserSettings>('agent_browser_settings', {})
  },
/**
 *  写 agent 的浏览器控制设置；缺席的格不改，交回写完的整份。 */
  async agentSetBrowserSettings(request: AgentBrowserSettingsPatch): Promise<AgentBrowserSettings> {
    return call<AgentBrowserSettings>('agent_set_browser_settings', { request: request })
  },
/**
 *  读取 agent 自己那份设置目录；连接不存在时按统一启动管线建立。
 * 
 *  目录是进程级事实（与连接锚在哪个工作区无关），整份一次交回：界面自己按归属切，
 *  不为了切页再问一遍 —— 那一问会多出一个到达时刻，跨格子的条件求值就对不齐了。 */
  async agentSettingsCatalog(): Promise<AgentSettingsCatalog> {
    return call<AgentSettingsCatalog>('agent_settings_catalog', {})
  },
/**
 *  改一格设置，交回**改完之后**整份目录的 settings 那一格。
 * 
 *  界面拿这一份刷新自己，不做乐观改写：改没改由 agent 自己说，那是它写的盘。 */
  async agentSetSetting(request: AgentSettingWriteRequest): Promise<AgentSettingEntry[]> {
    return call<AgentSettingEntry[]>('agent_set_setting', { request: request })
  },
  async agentThreads(): Promise<AgentThread[]> {
    return call<AgentThread[]>('agent_threads', {})
  },
  async agentThreadSnapshot(request: AgentThreadRequest): Promise<AgentThreadSnapshot> {
    return call<AgentThreadSnapshot>('agent_thread_snapshot', { request: request })
  },
  async agentExportThread(request: AgentExportThreadRequest): Promise<boolean> {
    return call<boolean>('agent_export_thread', { request: request })
  },
  async agentShareThread(request: AgentShareThreadRequest): Promise<AgentSharedThread> {
    return call<AgentSharedThread>('agent_share_thread', { request: request })
  },
  async agentOpenThread(request: AgentOpenThreadRequest): Promise<AgentOpenedThread> {
    return call<AgentOpenedThread>('agent_open_thread', { request: request })
  },
  async agentTranscript(request: AgentTranscriptRequest): Promise<AgentTranscriptJson> {
    return call<AgentTranscriptJson>('agent_transcript', { request: request })
  },
  async agentTranscriptOps(request: AgentTranscriptOpsRequest): Promise<AgentTranscriptJson> {
    return call<AgentTranscriptJson>('agent_transcript_ops', { request: request })
  },
  async agentSessionMedia(request: AgentSessionMediaRequest): Promise<AgentSessionMediaResult> {
    return call<AgentSessionMediaResult>('agent_session_media', { request: request })
  },
  async agentRenameThread(request: AgentRenameThreadRequest): Promise<null> {
    return call<null>('agent_rename_thread', { request: request })
  },
  async agentArchiveThread(request: AgentArchiveThreadRequest): Promise<null> {
    return call<null>('agent_archive_thread', { request: request })
  },
  async agentDeleteThread(request: AgentThreadRequest): Promise<null> {
    return call<null>('agent_delete_thread', { request: request })
  },
  async agentPinThread(request: AgentPinThreadRequest): Promise<null> {
    return call<null>('agent_pin_thread', { request: request })
  },
  async agentForkThread(request: AgentForkThreadRequest): Promise<AgentThread> {
    return call<AgentThread>('agent_fork_thread', { request: request })
  },
/**
 *  调用方只见脱敏后的 IPC 文案，永远拿不到原生细节。 */
  async assetSessionOpen(): Promise<AssetSessionResult> {
    return call<AssetSessionResult>('asset_session_open', {})
  },
  async assetImport(request: AssetImportRequest): Promise<AssetUploadResult[]> {
    return call<AssetUploadResult[]>('asset_import', { request: request })
  },
  async assetUpload(request: AssetUploadRequest): Promise<AssetUploadResult> {
    return call<AssetUploadResult>('asset_upload', { request: request })
  },
/**
 *  把注册表里那一份字节交给宿主。
 * 
 *  存在的理由只有一个：图片进门时不落盘，而 poietica-asset:// 的应答端在主进程里，
 *  拿不到注册表。注册表按 (session, hash) 记账，取的是**单个资产**，不是整张表。 */
  async assetRead(request: AssetReadRequest): Promise<AssetReadResult> {
    return call<AssetReadResult>('asset_read', { request: request })
  },
  async assetRemove(request: AssetRemoveRequest): Promise<null> {
    return call<null>('asset_remove', { request: request })
  },
  async automationsCreate(creation: AutomationCreation): Promise<AutomationCatalog> {
    return call<AutomationCatalog>('automations_create', { creation: creation })
  },
  async automationsUpdate(update: AutomationUpdate): Promise<AutomationCatalog> {
    return call<AutomationCatalog>('automations_update', { update: update })
  },
  async automationsEnable(id: string, revision: number, enabled: boolean): Promise<AutomationCatalog> {
    return call<AutomationCatalog>('automations_enable', { id: id, revision: revision, enabled: enabled })
  },
  async automationsRun(id: string, requestId: string): Promise<AutomationCatalog> {
    return call<AutomationCatalog>('automations_run', { id: id, requestId: requestId })
  },
  async automationsCancel(runId: string): Promise<AutomationCatalog> {
    return call<AutomationCatalog>('automations_cancel', { runId: runId })
  },
  async automationsPreview(schedule: string | null, timeZone: string): Promise<SchedulePreview> {
    return call<SchedulePreview>('automations_preview', { schedule: schedule, timeZone: timeZone })
  },
  async automationsLoad(): Promise<AutomationCatalog> {
    return call<AutomationCatalog>('automations_load', {})
  },
  async automationsRemove(id: string): Promise<AutomationCatalog> {
    return call<AutomationCatalog>('automations_remove', { id: id })
  },
  async environmentMcpConfig(): Promise<EnvironmentFile> {
    return call<EnvironmentFile>('environment_mcp_config', {})
  },
  async environmentMcpConfigWrite(expectedContents: string | null, contents: string): Promise<EnvironmentFile> {
    return call<EnvironmentFile>('environment_mcp_config_write', { expectedContents: expectedContents, contents: contents })
  },
  async launcherResolve(program: string): Promise<McpLauncher | null> {
    return call<McpLauncher | null>('launcher_resolve', { program: program })
  },
  async pluginsCatalogRead(): Promise<string | null> {
    return call<string | null>('plugins_catalog_read', {})
  },
  async pluginsCatalogRefresh(url: string): Promise<string> {
    return call<string>('plugins_catalog_refresh', { url: url })
  },
/**
 *  顺序不能反：先搬副本、后写账。反了会留下指向空气的记录，而 agent 会照着它装载。 */
  async pluginsCommit(request: PluginCommitRequest): Promise<null> {
    return call<null>('plugins_commit', { request: request })
  },
  async pluginsDiscard(stagingId: string): Promise<null> {
    return call<null>('plugins_discard', { stagingId: stagingId })
  },
/**
 *  只读探测，不 create_dir_all——目录不归我们所有；返回 None 即受控 home 未生效，没有第二本账。 */
  async pluginsForeignList(): Promise<ForeignPluginInventory | null> {
    return call<ForeignPluginInventory | null>('plugins_foreign_list', {})
  },
/**
 *  装没装以账本为准，不扫目录：官方卸载只删记录、盘上留副本，扫目录会把刚卸载的显示成装着。 */
  async pluginsList(): Promise<PluginPayload[]> {
    return call<PluginPayload[]>('plugins_list', {})
  },
  async pluginsRemove(pluginId: string): Promise<null> {
    return call<null>('plugins_remove', { pluginId: pluginId })
  },
  async pluginsSetEnabled(pluginId: string, enabled: boolean): Promise<null> {
    return call<null>('plugins_set_enabled', { pluginId: pluginId, enabled: enabled })
  },
/**
 *  落点是官方的 `capabilities.mcpServers.<name>.enabled`，即 `/plugins mcp disable` 写的同一格。 */
  async pluginsSetMcpEnabled(pluginId: string, server: string, enabled: boolean): Promise<null> {
    return call<null>('plugins_set_mcp_enabled', { pluginId: pluginId, server: server, enabled: enabled })
  },
  async pluginsStage(fetch: PluginFetch): Promise<PluginStaged> {
    return call<PluginStaged>('plugins_stage', { fetch: fetch })
  },
  async skillsCommit(request: SkillCommitRequest): Promise<null> {
    return call<null>('skills_commit', { request: request })
  },
  async skillsDiscard(stagingId: string): Promise<null> {
    return call<null>('skills_discard', { stagingId: stagingId })
  },
  async skillsList(): Promise<SkillRecord[]> {
    return call<SkillRecord[]>('skills_list', {})
  },
  async skillsTrash(name: string): Promise<null> {
    return call<null>('skills_trash', { name: name })
  },
  async skillsSetEnabled(name: string, enabled: boolean): Promise<null> {
    return call<null>('skills_set_enabled', { name: name, enabled: enabled })
  },
  async skillsStage(fetch: PluginFetch): Promise<SkillStaged> {
    return call<SkillStaged>('skills_stage', { fetch: fetch })
  },
  async terminalAttach(root: string, cols: number, rows: number): Promise<null> {
    return call<null>('terminal_attach', { root: root, cols: cols, rows: rows })
  },
  async terminalWrite(root: string, data: string): Promise<null> {
    return call<null>('terminal_write', { root: root, data: data })
  },
  async terminalResize(root: string, cols: number, rows: number): Promise<null> {
    return call<null>('terminal_resize', { root: root, cols: cols, rows: rows })
  },
  async terminalClose(root: string): Promise<null> {
    return call<null>('terminal_close', { root: root })
  },
  async settingsGet(): Promise<AppSettings> {
    return call<AppSettings>('settings_get', {})
  },
  async settingsSet(settings: AppSettings): Promise<SettingsWriteResult> {
    return call<SettingsWriteResult>('settings_set', { settings: settings })
  },
  async settingsReset(): Promise<SettingsWriteResult> {
    return call<SettingsWriteResult>('settings_reset', {})
  },
  async agentConfigGet(): Promise<AgentConfigSnapshot> {
    return call<AgentConfigSnapshot>('agent_config_get', {})
  },
/**
 *  渲染层交来的是描述符投影出来的那一份档案；形状在边界上再判一次，判据只有「是对象且有 id」。 */
  async agentConfigSave(profile: JsonValue): Promise<AgentConfigSnapshot> {
    return call<AgentConfigSnapshot>('agent_config_save', { profile: profile })
  },
/**
 *  最近 span 天的日账，由早到晚。没有账的日子不占行。 */
  async usageTokenDays(span: number): Promise<UsageDay[]> {
    return call<UsageDay[]>('usage_token_days', { span: span })
  },
/**
 *  最近 span 天里每个模型各自的日账，由早到晚。没有账的日子与模型不占行。 */
  async usageModelDays(span: number): Promise<UsageModelDay[]> {
    return call<UsageModelDay[]>('usage_model_days', { span: span })
  },
/**
 *  最近 span 天里发出去的句子数。准入那一行就是「用户说了一句话」，插话也照算。 */
  async usageMessageCount(span: number): Promise<number> {
    return call<number>('usage_message_count', { span: span })
  },
/**
 *  这台机器上，这个应用的数据根。
 * 
 *  # Errors
 * 
 *  根目录无法解析或创建时返回错误。 */
  async storageDataDirectory(): Promise<string> {
    return call<string>('storage_data_directory', {})
  },
  async workbenchSessionLoad(): Promise<string | null> {
    return call<string | null>('workbench_session_load', {})
  },
  async workbenchSessionSave(document: string): Promise<null> {
    return call<null>('workbench_session_save', { document: document })
  },
  async workspaceCreateProjectlessRoot(): Promise<string> {
    return call<string>('workspace_create_projectless_root', {})
  },
/**
 *  非 git 仓库或机器没有 git 时返回 None：界面据此整个隐藏分支 chip，不是错误。 */
  async gitBranches(root: string): Promise<GitBranches | null> {
    return call<GitBranches | null>('git_branches', { root: root })
  },
  async gitSwitchBranch(root: string, branch: string): Promise<GitBranches> {
    return call<GitBranches>('git_switch_branch', { root: root, branch: branch })
  },
  async gitCreateBranch(root: string, branch: string): Promise<GitBranches> {
    return call<GitBranches>('git_create_branch', { root: root, branch: branch })
  },
/**
 *  非 git 仓库或机器没有 git 时返回 None：界面据此整个隐藏这一格，不是错误。 */
  async gitReview(root: string, base: string, context: number, ignoreWhitespace: boolean): Promise<GitReview | null> {
    return call<GitReview | null>('git_review', { root: root, base: base, context: context, ignoreWhitespace: ignoreWhitespace })
  },
  async gitFilePatch(root: string, base: string, path: string, ignoreWhitespace: boolean): Promise<string> {
    return call<string>('git_file_patch', { root: root, base: base, path: path, ignoreWhitespace: ignoreWhitespace })
  },
  async gitCommit(request: GitCommitRequest): Promise<GitReview> {
    return call<GitReview>('git_commit', { request: request })
  },
  async gitWatchStart(root: string): Promise<GitWatchLease> {
    return call<GitWatchLease>('git_watch_start', { root: root })
  },
  async gitWatchStop(token: string): Promise<null> {
    return call<null>('git_watch_stop', { token: token })
  },
/**
 *  现在是什么状态。判据只有盘上那份安装与手上这份活，不查 agent，也不写任何第二份状态。 */
  async pythonKernelStatus(): Promise<PythonKernelStatus> {
    return call<PythonKernelStatus>('python_kernel_status', {})
  },
/**
 *  装一份。装好再调是空操作；正在装再调汇报当前进度，不重入。 */
  async pythonKernelInstall(): Promise<PythonKernelStatus> {
    return call<PythonKernelStatus>('python_kernel_install', {})
  },
/**
 *  删掉受管目录并清空设置。没装过时也是一次成功的空操作。 */
  async pythonKernelRemove(): Promise<PythonKernelStatus> {
    return call<PythonKernelStatus>('python_kernel_remove', {})
  }
}

export const events = {
  agentSessionEvent(handler: (payload: AgentSessionEvent) => void): () => void {
    return window.poietica.on('agent_session_event', handler as (payload: unknown) => void)
  },
  agentTranscriptEvent(handler: (payload: AgentTranscriptEvent) => void): () => void {
    return window.poietica.on('agent_transcript_event', handler as (payload: unknown) => void)
  },
  automationCatalogChanged(handler: (payload: AutomationCatalogChanged) => void): () => void {
    return window.poietica.on('automation_catalog_changed', handler as (payload: unknown) => void)
  },
  gitWorkingTreeChanged(handler: (payload: GitWorkingTreeChanged) => void): () => void {
    return window.poietica.on('git_working_tree_changed', handler as (payload: unknown) => void)
  },
  terminalStreamed(handler: (payload: TerminalStreamed) => void): () => void {
    return window.poietica.on('terminal_streamed', handler as (payload: unknown) => void)
  }
}

# omp Web / 浏览器 / 桌面 / 媒体 / 远程

> 来源：`CA/src/web/`、`CA/src/tools/browser/`、`CA/src/tools/computer/`、`CA/src/stt/`、`CA/src/tts/`、`CA/src/tools/image-gen.ts`、`CA/src/ssh/`、`CA/src/irc/`、`CA/src/internal-urls/`、`CA/src/cursor.ts`（18.3.0）。

## 1. web_search（`CA/src/web/search/`）

- **26 个具体引擎**（`SEARCH_PROVIDER_OPTIONS`）：anthropic、brave、codex、duckduckgo、ecosia、exa、firecrawl、gemini、google、jina、kagi、kimi、mojeek、ollama、openrouter、parallel、perplexity、public（免 key 公共搜索）、searxng、startpage、synthetic、tavily、tinyfish、xai、zai（另有 auto/none）。
- **grounded provider**（模型端 server-side search）：`gemini | anthropic | codex | xai | openrouter`（`GROUNDED_PROVIDER_LOADERS`；usage 计 `server.webSearch`）。
- 选择逻辑：web 角色候选池（`roleCandidatePool("web", settings, modelRegistry)`）→ 按角色链逐个 fallback，每次失败格式化进用户可见 fallback summary。
- 工具参数：`query`（必需）、`recency?`（day|week|month|year）、`limit?/max_tokens?/temperature?/num_search_results?`。
- 返回：`SearchSource {title, url, snippet?, publishedDate?, ageSeconds?, author?}` + `SearchCitation {url, title, citedText?}` + `SearchUsage {inputTokens?, outputTokens?, totalTokens?, searchRequests?}`。
- API key env：`EXA_API_KEY`、`BRAVE_API_KEY`、`PERPLEXITY_API_KEY/COOKIES`、`TAVILY_API_KEY`、`TINYFISH_API_KEY`、`FIRECRAWL_API_KEY`、`KAGI_API_KEY`、`SEARXNG_ENDPOINT/TOKEN/BASIC_USERNAME/BASIC_PASSWORD`；perplexity 支持 cookies 模式（`browser-page.ts`）；`UMANS_WEBSEARCH_PROVIDER`。
- 门控 `web_search.enabled`（默认 true）；`providers.webSearchTimeoutSeconds`。

## 2. 专用 scrapers（`CA/src/web/scrapers/`，90+ 站点 handler）

完整清单（每目录一个 handler）：artifacthub、arxiv、aur、biorxiv、bluesky、brew、cheatsh、chocolatey、choosealicense、cisa-kev、clojars、coingecko、crates-io、crossref、devto、discogs、discourse、dockerhub、docs-rs、fdroid、firefox-addons、flathub、github、github-gist、gitlab、go-pkg、hackage、hackernews、hex、huggingface、iacr、jetbrains-marketplace、lemmy、lobsters、mastodon、maven、mdn、metacpan、musicbrainz、npm、nuget、nvd、ollama、open-vsx、opencorporates、openlibrary、orcid、osv、packagist、pub-dev、pubmed、pypi、rawg、readthedocs、reddit、repology、rfc、rubygems、searchcode、sec-edgar、semantic-scholar、snapcraft、sourcegraph、spdx、spotify、stackoverflow、terraform、tldr、twitter、vimeo、vscode-marketplace、w3c、wikidata、wikipedia、youtube。
分类覆盖：code hosts（github/gitlab/sourcegraph）、package registries（npm/pypi/crates/rubygems/hex/hackage/metacpan/clojars/packagist/maven/go-pkg/nuget/dockerhub/aur/brew/chocolatey/flathub/snapcraft/fdroid/firefox-addons/open-vsx/vscode-marketplace/jetbrains-marketplace/huggingface/ollama/repology）、research（arxiv/biorxiv/pubmed/crossref/semantic-scholar/iacr/rfc/w3c/wikidata/wikipedia/openlibrary/orcid/opencorporates/sec-edgar）、forums/社区（stackoverflow/hackernews/lobsters/devto/reddit/lemmy/mastodon/bluesky/twitter/discourse）、docs（mdn/readthedocs/docs-rs/tldr/cheatsh/choosealicense/spdx/terraform）、security DB（nvd/osv/cisa-kev）、其它（youtube/vimeo/spotify/discogs/musicbrainz/coingecko/rawg/searchcode）。

## 3. 网页阅读管线（read URL → `CA/src/tools/fetch.ts`）

- provider 链：native（内建 readability）→ trafilatura → lynx → parallel → firecrawl → jina（reader API）；HTML→Markdown；feed 解析（RSS/Atom）；内容协商与 `.md` 后缀探测；binary/sqlite/archive 检测分流。
- `fetch.enabled` 门控（默认 true）；超时 20s（1–45）。
- reader 模式丢弃 base64 图与内联 SVG（保留 alt 文本，18.2.9 修复项）；`PI_DOCS_EMBED`；jina 兼容 env（LEGACY_ENV_KEYS：jina、brave、tinyfish、firecrawl）。
- 图片发布（把本地图发给模型/provider）：`images.urls.backends` 四种（provider-files / tailscale / cloudflared / litterbox）、TTL、ssh 隧道（`sshTarget/sshRemotePort 8787`）；`omp images status|doctor|probe|purge` 管理；blob-broker 的 provider-files（Anthropic/Gemini/OpenAI 文件 API 直传，见 subsystems.md §10）。

## 4. 浏览器控制（`CA/src/tools/browser/`，eval prelude `browser` 对象）

- **架构**：tab-supervisor / tab-worker（每标签页独立 worker）+ shared-daemon（跨会话共享 Chromium）+ browser-relay（`omp browser-relay serve|install`：本地 CDP relay + 浏览器扩展，`~/.omp/browser-relay/extension`，--port/--token）+ cmux 支持；Chromium 经 puppeteer-core（`PUPPETEER_EXECUTABLE_PATH/PROXY/PROXY_BYPASS_LOOPBACK/PROXY_IGNORE_CERT_ERRORS`）。
- **API 面**（prelude-definition + 各模块）：tab 打开/导航（navigation）、点击/输入/按键/拖拽/滚动/等待（interactions，`tab.fill`、`tab.press(key, {selector})`）、截图（screenshot）、**aria snapshot**（aria/aria-snapshot.ts）、**axe-core 无障碍审计**（a11y/）、JS eval、emulation（设备/媒体特性）、network 观察、console 捕获（console-capture）、dialogs、downloads、frames、init-scripts、storage-state、tracing、recording（录屏）、react 支持、readable（正文抽取）、webmcp（网页内 MCP）、queries/query-handlers、snapshot-plus、orphan-registry、attach/open-options/tab-arguments。
- 配置：`browser.enabled`（默认 true）、`browser.cdpUrl/relay/relayUrl/headless/cmux/freezeOnTurnEnd/idleCloseSec/screenshotDir`；超时默认 30s（1–300）。
- MCP 发现时若 browser prelude 可用则过滤外部 browser MCP（`mcpManager.reconcileBrowserFilter`）。
- 截图对比容忍轻微 rasterizer 差异（18.3.0）；`tab.fill` 对动画帧停滞页面的超时修复（18.2.11）。

## 5. 桌面控制（`CA/src/tools/computer/`，eval prelude `computer` 对象）

- 架构：`ComputerSupervisor`（supervisor.ts）spawn worker（`__omp_worker_computer`）；底层 pi-natives `DesktopSession`（跨平台：Windows 原生、macOS 需 Apple Events 权限——Xcode MCP 首连修复记录、Linux X11/Wayland）。
- **能力**（desktop.d.ts）：`listDisplays`、`listWindows`、`capture`（截图）、`click/moveMouse/drag/scroll/typeText/keyChord`（原生输入）、`raiseWindow`、**accessibility tree**：axSnapshot/axQuery/axElementAt/axFocused/axNode/axAttributes/axChildren/axParent/axPerform/axSetValue/axFocus/axClick。
- action：call/run/capabilities/close（`invokeComputer`）。
- 配置：`computer.enabled`（默认 **false**；`/computer` 斜杠命令开关）、`computer.display/maxWidth/maxHeight`；超时默认 120s（1–300）；独立审批 `computerApproval`。

## 6. 语音（`CA/src/stt/` + `CA/src/tts/`）

- **STT**（语音输入）：本地流式识别——sherpa-onnx-node runtime（sherpa-runtime.ts）+ 模型下载器（downloader/models）、endpointer（VAD）、submit-trigger（`stt.submitTrigger`）、增强模式（`speech.enhanced`）、asr-worker 独立进程（`__omp_worker_stt`；asr-client/asr-protocol）、wav 处理；`stt.enabled/language("en")`；依赖 optionalDependencies sherpa-onnx-node 1.13.2。
- **TTS**（语音输出）：本地 Kokoro（@huggingface/transformers 推理，tts-worker `__omp_worker_tts`）+ streaming-player（边生成边播）+ vocalizer/speakable/speech-enhancer；云链 xAI-TTS / openai-speech（pi-ai）；`omp say`（--voice/--model/--file/--out 写 WAV）；`tts.localVoice`、`speech.voice`。
- **live**（WebRTC 双向语音会话，见 subsystems.md §6）：pi-voice crate（Opus、SDP offer/answer、data-channel）。

## 7. generate_image

- 工具参数与门控见 tools.md §3.5；provider 链走 image role（openai-images、openrouter-images、google-generative-ai、google-gemini-cli、openai-responses、openai-codex-responses 六传输）。
- 粘贴剪贴板图片自动存 session artifact 目录（18.3.0），agent 可按路径读取/复制/上传；粘贴/拖入图片文件保留原始文件系统路径（18.2.9）。

## 8. SSH（`CA/src/ssh/`）

- `ssh://` URI scheme：read（远程文件读，read approval 升 exec；支持 selector `ssh://host/path:50-100`）、write（远程写）、bash（cwd 为 ssh 目标时远程执行）。
- 子模块：connection-manager（连接池）、file-transfer（scp/sftp）、sshfs-mount（远程挂载本地）、config-writer、utils。
- `omp ssh add|remove|list`（--host/--user/--port/--key/--desc/--compat/--scope project|user；配置存 `.omp/ssh.json`）；`remote-host/` 目录；`~/.omp/ssh-control/` control socket。

## 9. IRC（agent 间消息总线，`CA/src/irc/`）

- `IrcBus`（bus.ts）：进程全局 mailbox 总线；**`send` 永不阻塞**（不等对方生成）；投递经全局 AgentRegistry——parked agent 经 AgentLifecycleManager 复活、idle agent 以真 turn 唤醒、busy agent 在下一 step 边界收非中断 aside（`AgentSession.deliverIrcMessage` → 返回 "injected" | "woken"）。
- 每 agent mailbox 上限 `MAILBOX_CAP=100`（超出丢最老）；`IrcWaiter {from?, resolve, cancel}`。
- `wait` 工具可阻塞等 IRC 消息；task 子代理协作与 Agent Hub chat 走此总线；会话事件 `irc_message {message}`；配置 `taskIrcEnabled`（系统提示注入）；`enableIrc` 可移除。

## 10. 内部 URI schemes（`CA/src/internal-urls/`，read/write 通用）

| scheme | 语义 |
|---|---|
| `agent://` | agent 定位与消息（含 `?q=` 提取；write 直接向 agent 发消息——18.3.0 新增 agent 直发） |
| `artifact://` | 会话 artifact（截断全量恢复） |
| `memory://` | 记忆条目 |
| `skill://` | 技能全文（containRoot realpath 越界防护；Agent Plugins spec §4.1） |
| `rule://` | 规则文件（activeRules 解析，subagent 可读自己的规则） |
| `local://` | 本机协议文件（如 `local://PLAN.md`；LocalProtocolOptions 可覆盖 artifacts 目录与 sessionId） |
| `mcp://` | MCP 资源 |
| `history://` | 会话历史 |
| `proc://` | 受管进程（`proc://<id>/kill` 等；write 控制进程——18.3.0 起取消需显式 kill 目标） |
| `omp://` | 内嵌 harness 文档（`omp://` 全搜、`omp://<file>.md` 精确、`:start-end` selector；find/grep 可搜——18.2.9/18.3.0） |
| `vault://` | 凭据 vault |
| `security://` | 安全扫描产物 |
| `pr://` / `issue://` | GitHub PR/issue 即文件（`read pr://1428`） |
| `ssh://` | 远程文件 |
| `conflict://` | git 冲突区块（`@theirs/@ours/@base` 拼接替换；`conflict://*` 批量） |
| `attachment://N` | 会话图片附件 |
| `xd://` | 工具设备挂载（tools.md §6） |
| `db://` 等 | RPC 宿主可注册的自定义 scheme（host_uri_request） |

模块：agent/artifact/history/issue-pr/local/mcp/memory/omp/proc/rule/security/skill/ssh/vault/xd 协议文件 + docs-index、hyperlink-targets、registry-helpers、router、parse、omp-scope。

## 11. Cursor 桥（`CA/src/cursor.ts` + `cursor-bridge-tools.ts`）

与 Cursor 编辑器的桥接：cursor-agent 传输（HTTP/2 + protobuf，pi-ai providers/cursor.ts）+ 桥接工具集——使 omp 能以 Cursor 订阅凭据作为 provider 运行，advisor 的 Cursor 资源帧（pi_grep/pi_edit、list_mcp_resources/read_mcp_resource）经 CursorMcpResourceAdapter 应答。

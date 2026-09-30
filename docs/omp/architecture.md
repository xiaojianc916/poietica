# omp 架构与原生核心

> 来源：官方 README（can1357/oh-my-pi）、各包 package.json/README、`NAT/native/*.d.ts`（18.3.0）。

## 1. monorepo 概况

- 仓库：github.com/can1357/oh-my-pi；16 个 TypeScript 包 + 9 个 Rust crate；约 80k 行 Rust 核心。
- 公司：Stencil Labs, Inc.（stencil.so）；maintainer can1357；contributor Mario Zechner（Pi 原作者——omp 是 Pi 的深度 fork）。
- License：MIT（vendored brush-shell 等第三方保留上游许可，见 THIRD-PARTY-NOTICES.txt）。
- 运行时：Bun ≥ 1.3.14（cli.ts 启动硬校验）；TS 源码直接随 npm 发布（main 指向 `src/index.ts`，非 dist）。
- 文档：omp.sh（官网）/ omp.sh/docs（62 页）；Discord：discord.gg/4NMW9cdXZa。

## 2. TypeScript 包（16 个，全部 `@oh-my-pi/*`）

| 包 | 官方描述/职责 |
|---|---|
| `pi-coding-agent` | 核心实现包：CLI、全部模式、工具、会话、配置、扩展（bin: `omp`） |
| `pi-ai` | "Unified LLM API with automatic model discovery and provider configuration" |
| `pi-catalog` | "Model catalog for omp: bundled model database, provider discovery descriptors, model identity, classification, and equivalence" |
| `pi-agent-core` | Agent 循环、工具协议、压缩引擎（provider 无关内核） |
| `pi-tui` | "Terminal User Interface library with differential rendering for efficient text-based applications" |
| `pi-natives` | Rust N-API 绑定的 JS loader；平台二进制经 optionalDependencies（`pi-natives-<platform>-<arch>`）分发 |
| `pi-wire` | "Shared wire protocol types for omp packages"（collab / skillshare / stream 协议类型） |
| `pi-utils` | 基础设施：dirs/env/sqlite/frontmatter/readability/turndown/vterm/mermaid-ascii/logger/postmortem/file-lock/procmgr/yaml-config 等 50+ 模块 |
| `snapcompact` | 上下文→PNG 帧的确定性归档压缩（光栅化在 Rust） |
| `pi-mnemopi` | 本地记忆引擎（embedding/检索/巩固） |
| `omp-stats` | 用量统计（stats.db + activity worker） |
| `omnitype` | arktype/typebox/zod 兼容校验层（omptype；扩展/自定义工具的 schema 注入来源） |

## 3. Rust 核心（6 crate + 平台包）

| Crate | 职责 | 约行数 |
|---|---|---|
| `pi-shell` | 内嵌 bash（vendored brush-shell）、持久 shell 会话、coreutils 分发 | 38,000 |
| `pi-natives` | N-API surface（grep/find/SIXEL/audio/WebRTC/PDF/VCS/EditStore/Shell/Pty/Desktop…） | 25,000 |
| `pi-walker` | 并行、ignore 感知目录遍历 + 扫描缓存 | 5,200 |
| `pi-iso` | 工作区隔离（APFS/btrfs/zfs/reflink/overlayfs/projfs/block-clone/rcopy） | 3,300 |
| `pi-ast` | tree-sitter + ast-grep 绑定 | 2,900 |
| `pi-voice` | 音频、Opus、WebRTC | 1,000 |

**平台矩阵**：6 平台构建（Linux/macOS/Windows × x64/arm64）；x64 双 ISA（modern=AVX2 + baseline）；发布形态为 core 包（仅 JS loader + .d.ts + README）+ `pi-natives-<platform>-<arch>` optionalDependencies；`PI_TEST_NO_NATIVES` 可在测试中禁用。

## 4. pi-natives 全导出面（`NAT/native/index.d.ts` 等，18.3.0）

**类（19 个）**：

| 类 | 能力 |
|---|---|
| `Shell` | 内嵌 bash 持久会话（push 命令、finishSide） |
| `PtySession` / `TtyWriter` | PTY 会话与终端写 |
| `Process` | 进程管理 |
| `EditSession` / `EditStore` / `DiffStream` / `HighlightStream` | 编辑内核：recordSnapshot/recordSeenLines/headHash/byHashText/invalidate/relocate（hashline stale 检测的真相源）、增量 diff 预览、语法高亮流（`supportsLanguage`/`warmHighlighter`） |
| `DesktopSession` | 桌面控制：listDisplays/listWindows/capture/click/moveMouse/drag/scroll/typeText/keyChord/raiseWindow/accessibility tree（axSnapshot/axQuery/axElementAt/axFocused/axNode/axAttributes/axChildren/axParent/axPerform/axSetValue/axFocus/axClick） |
| `AudioCapture` / `AudioPlayback` | 低延迟麦克风采集 / 无缝扬声器回放（setGain） |
| `LiveWebRtcPeer` | WebRTC（原生 Opus、SDP offer/answer、data-channel；供 live 会话） |
| `VcsRepo` / `VcsGitRepo` / `VcsJjWorkspace` | git + Jujutsu 双 VCS 抽象（status/commit/push/worktree/hunk 选择/watch） |
| `FileLock` | 进程持有跨进程锁（Linux/Windows 内核命名锁；其它 Unix flock(2) sidecar） |
| `NativeOAuthCallback` | OAuth 本地回调 |
| `PowerAssertion` | `power.sleepPrevention` 的系统电源断言 |
| `MacAppearanceObserver` | macOS 外观（深浅色）观察（主题跟随） |

**函数（全导出节选，按域）**：
- 搜索：`grep`（ripgrep 引擎 + 原生遍历）、`find`（glob + gitignore）
- AST：`astGrep` / `astEdit` / `astMatch`（`AstMatchStrictness`）
- 终端图形：`encodeSixel` / `decodeSixelToPng`；文本度量 `truncateToWidth` / `visibleWidth` / `wrapTextWithAnsi`
- 文档：`pdfToMarkdown`（内存 PDF→Markdown + OCR 页分类，pdf-inspector）
- token：`countTokens`（离线多 encoding）
- 向量：`cosineSimilarityPairs` / `vectorIndexTopK`（mnemopi 检索原语）
- 剪贴板：`copyToClipboard` / `readImageFromClipboard`
- Apple：`appleFmAvailability/Generate/Cancel`（Foundation Models）、`deviceCheckGenerateToken`、`detectMacOSAppearance`
- 块定位：`blockRangeAt`（代码块范围）
- VCS：`vcsDiscover/vcsGitDiscover/vcsJjDiscover/vcsIsPureJj/vcsGitClone/vcsDetachGitDir/vcsJoinPatches/vcsValidateHunkSelections`
- 其它：`__ompInstallTokioRuntime`、`__piNativesV18_3_0`（版本哨兵）

**README 声明的能力域**：Grep、Find、SIXEL（无 Bun 内建等价物；通用图像处理走 Bun.Image）、Audio、WebRTC、File locking、PDF。

## 5. 内嵌 shell 与 coreutils

- bash 来自 vendored **brush-shell**（THIRD-PARTY-NOTICES），进程内持久运行（环境跨调用保持）。
- 进程内 coreutils：bash 内建约 46 个（工具层口径）；uutils 系移植 CLI 工具 58 个（README 口径）；`PI_DISABLE_UUTILS_BUILTINS` 关闭后系统提示不再宣传。

# omp 代码智能（LSP / DAP / 编辑 / 安全扫描 / markit / jfind）

> 来源：`CA/src/lsp/`、`CA/src/dap/`、`CA/src/edit/`、`CA/src/security/`、`CA/src/markit/`、`CA/src/tools/jfind/`（18.3.0）。

## 1. LSP（`CA/src/lsp/`）

### 1.1 lsp 工具（14 action）
`diagnostics`、`definition`、`references`、`hover`、`symbols`、`rename`、`rename_file`、`code_actions`、`type_definition`、`implementation`、`status`、`reload`、`capabilities`、`request`（原始请求透传）。
参数：`action`（必需）、`file?/line?/symbol?/query?/new_name?/apply?/payload?`、`timeout?`（默认 20s，范围 5–300）。
approval：只读 action 集合（LSP_READONLY_ACTIONS）read，rename 等为 write；`lspReadOnly` 限制为导航+诊断（受限会话默认 true）。
门控：`lsp.enabled`（默认 true）+ `session.enableLsp`。

### 1.2 内置语言服务器表（`lsp/defaults.json`，54 个）
rust-analyzer（capabilities: flycheck/ssr/expandMacro/runnables/relatedTests）、tlaplus、clangd（--background-index --clang-tidy --header-insertion=iwyu）、zls、gopls（unusedparams/shadow/staticcheck/gofumpt）、typescript-language-server（inlay hints 全开）、typescript-native（tsc --lsp）、biome（isLinter）、eslint（isLinter）、denols、vscode-html/css/json-language-server、tailwindcss、svelte、vue-language-server、astro、pyright、basedpyright、pylsp、ty、ruff、jdtls、kotlin-lsp、metals、hls、ocamllsp、elixirls、expert、erlangls、gleam、solargraph、ruby-lsp、rubocop、bashls、lua-language-server、intelephense、phpactor、omnisharp、yamlls、terraformls、dockerls、helm-ls、nixd、nil、ols、dartls、marksman、texlab、graphql、prismals、vimls、emmet-language-server、sourcekit-lsp、swiftlint。
每条目：command/args/fileTypes/rootMarkers/initOptions/settings/capabilities/isLinter。

### 1.3 集成细节
- rename 走 `workspace/willRenameFiles`（rename_file）。
- `formatOnWrite`：写后格式化（优先专用 isLinter formatter server——当类型检查器同时声明该文件时，#12847）；`diagnosticsOnWrite/Edit`（延迟诊断：edit/write 返回后到达的诊断经 `queueDeferredDiagnostics` 注入 yield 队列，按 `bumpFileMutationVersion` 丢弃陈旧）；`diagnosticsDeduplicate`；workspace-diagnostics 全局扫描；诊断 ledger（diagnostics-ledger.ts）。
- **lsp mux daemon**（`lsp/mux/` daemon/protocol/server + `lspmux.ts`）：跨会话共享 language server（env `OMP_LSP_MUX_SOCKET/OMP_LSP_MUX_PROJECT_DIR`；设置 `lsp.shared/lazy`）；`PI_DISABLE_LSPMUX` 禁用；startup-events、writethrough。
- 专项 client：biome-client、lsp-linter-client、swiftlint-client。
- 文件创建/删除与 server reload 后诊断刷新（18.2.9）。

## 2. DAP 调试器（`CA/src/dap/`）

### 2.1 debug 工具（28 action）
launch、attach、set_breakpoint、remove_breakpoint、set_instruction_breakpoint、remove_instruction_breakpoint、data_breakpoint_info、set_data_breakpoint、remove_data_breakpoint、continue、step_over、step_in、step_out、pause、evaluate、stack_trace、threads、scopes、variables、disassemble、read_memory、write_memory、modules、loaded_sources、custom_request、output、terminate、sessions。
参数（可选字段全集）：program/args/adapter/cwd/file/line/function/name/condition/hit_condition/expression/context/frame_id/scope_id/variable_ref/pid/port/host/levels/memory_reference/instruction_*/count/data/data_id/access_type/command/arguments/offset/resolve_symbols/allow_partial/start_module/module_count/timeout。
approval：只读 action（output/threads/stack_trace/scopes/variables/disassemble/read_memory/loaded_sources/modules/sessions）read，其余 exec。门控 `debug.enabled`（默认 true）。

### 2.2 适配器表（`dap/defaults.json`，14 个）
| adapter | command | 语言 |
|---|---|---|
| gdb | `gdb -i dap` | c/cpp/rust |
| lldb-dap | `lldb-dap` | c/cpp/objc/swift/rust/zig |
| codelldb | `codelldb --port 0` | c/cpp/rust/zig |
| debugpy | `python -m debugpy.adapter` | python（justMyCode false） |
| dlv | `dlv dap`（socket 连接） | go（acceptsDirectoryProgram） |
| js-debug-adapter | `js-debug-adapter`（pwa-node） | js/ts |
| netcoredbg | `netcoredbg --interpreter=v…` | .NET |
| kotlin-debug-adapter | — | kotlin |
| rdbg | — | ruby |
| php-debug-adapter | — | php |
| bash-debug-adapter | — | bash |
| dart-debug-adapter / flutter-debug-adapter | — | dart/flutter |
| elixir-ls-debugger | — | elixir |
每条目 languages/fileTypes/rootMarkers/launchDefaults（request/stopOnEntry/…）/attachDefaults。
自定义条目经 `dap.json`。

## 3. 编辑系统（`CA/src/edit/`）

### 3.1 hashline 锚点机制
- read 输出以 `[path#TAG]` 行首标注（TAG = 内容短哈希；格式定义 `@oh-my-pi/pi-tui/tools/hashline-format`，`HL_FILE_HASH_LENGTH` 等）。
- edit 以 TAG 校验目标区域未被并发修改（**stale 检测拒绝陈旧 patch**，降低重试与 token——官方 README：Grok 4 Fast 输出 token −61%）。
- fuzzy 匹配：`#allowFuzzy`/`#fuzzyThreshold`（构造函数读取 `edit.fuzzyMatch/fuzzyThreshold` 配置）。
- 底层真相源：Rust `EditStore`（recordSnapshot/recordSeenLines/recordSeenLinesFromBody/headText/headHash/byHashText/seenLines/invalidate/relocate/clear/release）。

### 3.2 五种模式（`edit/schemas.ts`）
| 模式 | 参数 |
|---|---|
| `replace` | path, old_string, new_string, replace_all? |
| `patch` | path, edits[{op?: 'create'|'delete'|'update', rename?, diff?}] |
| `apply_patch` | input（整段 V4A patch 文本；customWireName `apply_patch`） |
| `hashline` | input（hashline 锚点编辑文本） |
| `sloppy` | input（宽松输入） |
- `edit.mode` 配置选择；`PI_EDIT_VARIANT` 覆盖；`edit.modelVariants`（record：model 名 pattern → patch/replace/hashline/apply_patch）按模型选模式；`settings.getEditVariantForModel(model)`。
- **18.3.0 Breaking**：patch 语法改用 `*** Edit File:`、`*** Find`、`*** Replace` 头（替换旧 `SM:` 头）；新增 `*** Insert Before` / `*** Insert After`（不替换既有代码插入行）。
- `edit.streamingAbort`、`edit.recoverInlineEdits`（恢复内联编辑）、`edit.enforceSeenLines`（必须先 read 过的行）、`edit.blackbox.enabled`、`edit.blockAutoGenerated`（原生检测拒绝生成文件）。

### 3.3 auto-repair（`edit/auto-repair.ts` + auto-repair.md）
失败编辑自动修复重试（`edit.autoRepair.enabled`）；流式参数预览：`EditTool.openArgStream` + 原生 EditStore 增量 diff（`tool_stream_update` 事件实时投影）；stream matcher 用 `matcherDigest`（真实文件内容而非 JSON 转义）渲染（TTSR per-file 匹配依赖此钩子）。

### 3.4 ast_grep / ast_edit（pi-ast crate）
- ast_grep：`pat`（AST pattern 必需）、`path?`（文件/目录/glob/内部 URI，分号分隔）、`lang?`、`skip?`；approval read；`loadMode: discoverable`。
- ast_edit：`ops: [{pat, out}]`（≥1）、`paths: string[]`（≥1）；`deferrable=true`——大改写先"暂存预览"，模型 `write xd://resolve|reject` 定夺（`CA/src/tools/index.ts` 为含 deferrable 工具的会话强制保留 write；`tools/resolve.ts` 实现解析设备）。
- `AstMatchStrictness`；tree-sitter grammars 集由 pi-ast crate 决定。

## 4. security_scan（`CA/src/security/`）

两段编排（工具 action：preflight/start/status/cancel/validate + cloud_scans/cloud_start/cloud_status/cloud_pull）：
- **OMP 原生扫描**：target_kind `repository|scoped_path|ref_diff|working_tree`；include_paths/exclude_paths、base_revision/head_revision、knowledge_base_paths、output_root、archive_existing、credential_id、scan_id、finding_id + validation workflow（validation_status/summary/evidence）。子模块：auth、cloud、comparison、contracts、coordinator、importers、preflight、provenance、publication。状态目录 `~/.omp/security/`。
- **Codex Security 云操作**：cloud_configuration_id/repository_id/repository_url/environment_id/lookback_days。
- 门控 `security.enabled`（默认 **false**；execute 内部二次校验）。

## 5. sharpshooter（记忆 backend 之一，详见 memory-cognition.md）

extract/consolidate/queue/scheduler/paths/backend/types；`sharpshooter.model`、`intervalMinutes(5)`、`injectionTokenLimit(15000)`。

## 6. markit（`CA/src/markit/`）

文档转换管线（converters/registry/types/NOTICE）：read 工具对二进制文档调用——PDF（内存转换 + OCR 页分类 `pdfToMarkdown`，pi-natives pdf-inspector）、DOCX（pi-utils/docx）等 office/文档格式 → 结构化 Markdown；转换缓存 `~/.omp/agent/cache/document-conversions/`。

## 7. jfind（find 工具内核，`CA/src/tools/jfind/`）

语义检索级联（cascade.ts）：词法先验（grep_keywords）→ 文件名排序 → verifier judge；返回 hits（相对路径、contentScore、行区间+snippet）；无命中标 `useless`、全部请求失败标 error；尾行统计（tokens/成本/耗时）；支持 `omp://` 文档范围（临时物化后重映射）；`find.enabled=auto`（仅 judge 由原生模型承载时开）。

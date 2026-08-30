# Poietica 现状架构报告（As-Built）

> 口径：本报告描述**仓库当前真实形态**，不是 `Architecture/` 里的目标态方案。
> 生成方式：目录树由 `git ls-files`（958 个受版本跟踪文件）机器生成，因此与磁盘一致。
> 已排除：`node_modules/`、`target/`、`dist/`、`.turbo/`、`.tsbuild/`、`gen/`、`dist-release/`、`.workbuddy/`、
> lockfile 内容、以及 `src-tauri/icons/` 下 52 个图标资产（折叠为一行，逐个列出不增加信息）。
> 生成时间：2026-08-30，分支 `main`，HEAD `2b3bf49a`。
> 与宪法的冲突处理：本文**解释**，可执行的定义只在 `tools/architecture/layering.ts` 等裁决处；
> 本文与它们不一致时以它们为准（并见 §4.13 偏差登记，其中三条就是本文抓出来的文档落后于代码）。

---

## 一、项目结构图

### 1.1 全栈俯视：两个组合根 + 一条契约回路

```text
┌─────────────────────────────── 用户屏幕 ────────────────────────────────┐
│  原生窗口（Tauri 2.5.1 · decorations:false · visible:false · 自绘标题栏） │
│  ├─ WebView 主文档  apps/desktop/index.html                              │
│  └─ 内置浏览器：Window::add_child 原生子 webview（不是 iframe）           │
└─────────────────────────────────────────────────────────────────────────┘
                ▲ React 19 渲染                     │ 只有三条命令路
                │（timeline 投影 → 表面视图）        ▼（prompt / cancel / resolvePermission 等）
┌───────────────┴──────────────────────────────────────────────────────────┐
│  TS 侧 · 八环单向依赖（tools/architecture/layering.ts 裁决）              │
│                                                                          │
│  环7 组合根      apps/desktop/src .................... 只接线，不裁决     │
│       ↓          entry/compose-runtime.ts = 前端唯一装配点               │
│  环6 表面        @poietica/surfaces ................... 六域视图一个包    │
│  环5 表现基座    @poietica/design-system .............. 令牌+主题+控件   │
│       ↓                                                                │
│  环4 适配        @poietica/native-bridge .............. 唯一碰 @tauri-apps│
│       ↓                                                                │
│  环3 领域        conversation · automation · browser · extension        │
│                  review · settings · update · workspace（八个，同环禁边） │
│  环2 agent档案   @poietica/agent-catalog .............. 厂商名只在这里   │
│  环1 词汇        @poietica/problem · external-store                     │
│  环0 契约        @poietica/contract ................... 生成物，禁手改   │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ commands.* / events.*（生成的 103 条命令、6 个事件）
┌───────────────────────────────┴──────────────────────────────────────────┐
│  Rust 侧 · 一个组合根 + 十二个宿主无关 crate                              │
│                                                                          │
│  apps/desktop/src-tauri 【组合根】                                        │
│    composition.rs 装配 → ipc/mod.rs::surface() 一份清单两用              │
│    ├─ ipc/commands/  解参 · DTO 互转 · emit（conversation/cli/ledger/…） │
│    ├─ window/ tray · 生命周期 · 几何   webview/ 子 webview 宿主           │
│    ├─ asset_protocol/  poietica-asset:// 的 HTTP 面                      │
│    ├─ journal 线程  16ms 攒批 → 先落库 → 再 emit                          │
│    ├─ paths.rs  磁盘布局唯一声明处     shutdown.rs  唯一退出屏障          │
│    └─ diagnostics/ panic hook + 结构化日志                               │
│                          ↓ 只向下调                                       │
│    协议适配  poietica-kap-client（frame.rs = 帧形状唯一产地）             │
│    适配环    poietica-ledger（唯一 SQLite 账本）· poietica-git-adapter    │
│    领域核    poietica-conversation（准入/轮次/投递/投影，零 IO）          │
│    能力      asset · browser · extension · review · update · process-host │
│    地基      poietica-problem（21 错误码）· poietica-time（可注入时钟）    │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ WebSocket + REST（kap 协议）
┌───────────────────────────────┴──────────────────────────────────────────┐
│  kimi web（@moonshot-ai/kimi-code 子进程，kap server · 受控 home）        │
│  协议正本：contracts/kap/{openapi,asyncapi,capabilities,checksums}.json   │
└──────────────────────────────────────────────────────────────────────────┘
```

### 1.2 契约回路：一份清单，三个读者

```text
apps/desktop/src-tauri/src/ipc/mod.rs :: surface()
   │  collect_commands![…] 103 条 · collect_events![…] 6 个 · .typ::<…>() 76 个 DTO
   ├─→ 运行期①  .invoke_handler(ipc.invoke_handler())        composition.rs:78
   ├─→ 运行期②  ipc.mount_events(app)                        composition.rs:86
   └─→ 构建期    cargo run -p poietica --bin export-ipc-bindings
                     └─→ packages/contract/src/generated/ipc-bindings.ts（2280 行，受跟踪）
                             └─→ 唯一读者 packages/native-bridge/（TS 侧唯一原生适配层）
                                     └─→ apps/desktop/src/entry/compose-runtime.ts（前端组合根注入端口）

漂移门禁：bun run ipc:check（重生绑定后断言工作区未变）· bun run kap:spec:check（快照对账）
```

### 1.3 一帧从 agent 到屏幕（唯一写入路径）

```text
kimi web ──WS 事件帧──▶ kap-client/session/driver.rs ──▶ session/router.rs
   │                                                            │
   │                            RunSlot（一轮一个记录器）◀───────┘
   │                                    │ Recorder.shape()  ← 成形（锁外，序号只算不用）
   │                                    ▼ Recorder.deliver() ← 投递（成功才算用掉位置）
   └────────────────────────────── FrameSink（try_send 即答，契约是不阻塞）
                                        │ sync_channel(4096)
                                        ▼  线程 poietica-frame-journal
                              攒批：16ms 窗口 ∪ 256 帧上限
                                        ▼
                     persist_then_emit：先落库（重试 50→400ms，超限永久失败）
                                        │ ledger.append(thread_id, seq=max+1)
                                        ▼
                     conversation_events 表（唯一键 thread_id+seq；重放 ≡ 实时）
                                        ▼ app.emit("ai-run-event", 信封并回载荷顶层)
                     transcript-store（按会话号路由）→ timeline 投影 → React 虚拟滚动
```

---
> 目录树生成脚本：`git -c core.quotePath=false ls-files` → 按"目录先、名升序"渲染；本报告由 agent 于 2026-08-30 生成，是一次快照，**不是常驻文档**，代码收敛后请重新生成而不是手工修补。

---

## 二、完整目录树（英文实际目录，到每一个文件）

共 958 个受跟踪文件，逐文件列出（仅 `src-tauri/icons/` 的图标资产折叠为一行）。排除依赖与构建产物。

```text
poietica/
├── .githooks/
│   ├── pre-commit
│   └── pre-push
├── .github/
│   ├── actions/
│   │   └── setup-js/
│   │       └── action.yml
│   └── workflows/
│       ├── quality.yml
│       ├── release.yml
│       └── security.yml
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── assistant/
│       │   │   ├── assistant-pane.tsx
│       │   │   ├── assistant-sidebar-panel.tsx
│       │   │   ├── assistant-wiring.tsx
│       │   │   ├── conversation-commands.tsx
│       │   │   ├── conversation-header.css
│       │   │   ├── conversation-header.tsx
│       │   │   ├── conversation-surface.tsx
│       │   │   ├── review-pane.tsx
│       │   │   ├── threads-context.ts
│       │   │   ├── threads-provider.tsx
│       │   │   ├── workspace-collapse.ts
│       │   │   └── workspace-git.ts
│       │   ├── automation/
│       │   │   ├── automation-runtime.tsx
│       │   │   └── automations-view.tsx
│       │   ├── browser/
│       │   │   ├── browser-dock.tsx
│       │   │   ├── browser-pick.ts
│       │   │   ├── browser-region.tsx
│       │   │   └── browser-runtime.ts
│       │   ├── entry/
│       │   │   ├── agent-runtime.ts
│       │   │   ├── attachment-intake.ts
│       │   │   ├── automations-mcp.ts
│       │   │   ├── browser-collectors.test.ts
│       │   │   ├── browser-collectors.ts
│       │   │   ├── browser-mcp.ts
│       │   │   ├── compose-runtime.ts
│       │   │   ├── element-picker-runtime.ts
│       │   │   ├── main.tsx
│       │   │   ├── mount.tsx
│       │   │   ├── plugin-runtime.tsx
│       │   │   ├── pre-react-entry.ts
│       │   │   ├── thinking-preference.test.ts
│       │   │   ├── thinking-preference.ts
│       │   │   └── workspace-root.ts
│       │   ├── notice/
│       │   │   ├── assets/
│       │   │   │   └── error-robot.svg
│       │   │   ├── error-boundary.tsx
│       │   │   ├── notice-region.tsx
│       │   │   ├── notices.test.ts
│       │   │   ├── notices.ts
│       │   │   ├── problem-presentation.test.ts
│       │   │   ├── problem-presentation.ts
│       │   │   └── terminal-screen.tsx
│       │   ├── shell/
│       │   │   ├── commands/
│       │   │   │   ├── app-commands.ts
│       │   │   │   ├── command-palette.tsx
│       │   │   │   ├── index.ts
│       │   │   │   └── keybinding.ts
│       │   │   ├── sidebar/
│       │   │   │   ├── sidebar-footer.tsx
│       │   │   │   ├── sidebar-nav.tsx
│       │   │   │   ├── sidebar-region.tsx
│       │   │   │   ├── sidebar-rows.css
│       │   │   │   └── workspace-sidebar.tsx
│       │   │   ├── app-shell.tsx
│       │   │   ├── chrome-workbench-tabs.css
│       │   │   ├── index.ts
│       │   │   ├── parts.ts
│       │   │   ├── shell-contract.ts
│       │   │   ├── surface-host.tsx
│       │   │   ├── surface-icons.ts
│       │   │   ├── surface.ts
│       │   │   ├── use-workbench-tabs-baseline-gap.ts
│       │   │   ├── use-workbench-tabs-interactions.ts
│       │   │   ├── use-workbench-tabs-viewport.ts
│       │   │   ├── workbench-tab.tsx
│       │   │   ├── workbench-tabs.tsx
│       │   │   ├── workspace-container.tsx
│       │   │   ├── workspace-frame.tsx
│       │   │   ├── workspace-layout-store.test.ts
│       │   │   ├── workspace-layout-store.ts
│       │   │   ├── workspace-shell.css
│       │   │   └── workspace-shell.tsx
│       │   ├── styles/
│       │   │   └── app.css
│       │   ├── update/
│       │   │   ├── update-capsule.tsx
│       │   │   ├── update-phase.ts
│       │   │   └── update-row.tsx
│       │   ├── window/
│       │   │   ├── context-menu-guard.ts
│       │   │   ├── desktop-title-bar.css
│       │   │   ├── desktop-title-bar.tsx
│       │   │   ├── external-links.ts
│       │   │   ├── scrollbar-size.ts
│       │   │   ├── table-downloads.ts
│       │   │   ├── use-window-chrome.ts
│       │   │   └── window-controls.tsx
│       │   └── vite-env.d.ts
│       ├── src-tauri/
│       │   ├── capabilities/
│       │   │   └── main-window.json
│       │   ├── icons/
│       │   └── …（52 个图标资产：32/64/128/128@2x + icon.png/.icns/.ico + 9 张 Windows 方砖 + android/ 21 张 + ios/ 18 张，折叠）
│       │   ├── permissions/
│       │   │   ├── asset.json
│       │   │   ├── clipboard.json
│       │   │   ├── dialog.json
│       │   │   ├── file.json
│       │   │   ├── opener.json
│       │   │   ├── plugin.json
│       │   │   ├── settings.json
│       │   │   └── window.json
│       │   ├── src/
│       │   │   ├── asset_protocol/
│       │   │   │   ├── handler.rs
│       │   │   │   ├── mod.rs
│       │   │   │   ├── range.rs
│       │   │   │   └── response.rs
│       │   │   ├── bin/
│       │   │   │   └── export-ipc-bindings.rs
│       │   │   ├── diagnostics/
│       │   │   │   ├── crash_report.rs
│       │   │   │   ├── mod.rs
│       │   │   │   └── structured_log.rs
│       │   │   ├── ipc/
│       │   │   │   ├── commands/
│       │   │   │   │   ├── asset/
│       │   │   │   │   │   └── attachments.rs
│       │   │   │   │   ├── automation/
│       │   │   │   │   │   └── mcp_server.rs
│       │   │   │   │   ├── cli/
│       │   │   │   │   │   ├── exec.rs
│       │   │   │   │   │   ├── install.rs
│       │   │   │   │   │   ├── mod.rs
│       │   │   │   │   │   ├── probe.rs
│       │   │   │   │   │   └── profile.rs
│       │   │   │   │   ├── conversation/
│       │   │   │   │   │   ├── addressing.rs
│       │   │   │   │   │   ├── attachment.rs
│       │   │   │   │   │   ├── config.rs
│       │   │   │   │   │   ├── custom_agents.rs
│       │   │   │   │   │   ├── dto.rs
│       │   │   │   │   │   ├── failure.rs
│       │   │   │   │   │   ├── gateway.rs
│       │   │   │   │   │   ├── journal.rs
│       │   │   │   │   │   ├── mod.rs
│       │   │   │   │   │   ├── runtime.rs
│       │   │   │   │   │   ├── thread.rs
│       │   │   │   │   │   ├── toolkit.rs
│       │   │   │   │   │   └── turn.rs
│       │   │   │   │   ├── extension/
│       │   │   │   │   │   └── catalog_server.rs
│       │   │   │   │   ├── ledger/
│       │   │   │   │   │   ├── local_index.rs
│       │   │   │   │   │   ├── mod.rs
│       │   │   │   │   │   ├── usage.rs
│       │   │   │   │   │   └── workbench.rs
│       │   │   │   │   ├── workspace/
│       │   │   │   │   │   ├── environment.rs
│       │   │   │   │   │   ├── storage.rs
│       │   │   │   │   │   └── table.rs
│       │   │   │   │   ├── asset.rs
│       │   │   │   │   ├── automation.rs
│       │   │   │   │   ├── diagnostics.rs
│       │   │   │   │   ├── extension.rs
│       │   │   │   │   ├── git.rs
│       │   │   │   │   ├── launcher.rs
│       │   │   │   │   ├── mod.rs
│       │   │   │   │   ├── settings.rs
│       │   │   │   │   ├── skills.rs
│       │   │   │   │   ├── updates.rs
│       │   │   │   │   ├── window.rs
│       │   │   │   │   └── workspace.rs
│       │   │   │   ├── export_bindings.rs
│       │   │   │   ├── mod.rs
│       │   │   │   └── problem.rs
│       │   │   ├── webview/
│       │   │   │   ├── bounds.rs
│       │   │   │   ├── bridge.rs
│       │   │   │   ├── child_view.rs
│       │   │   │   ├── mod.rs
│       │   │   │   └── picker_bridge.rs
│       │   │   ├── window/
│       │   │   │   ├── lifecycle.rs
│       │   │   │   ├── mod.rs
│       │   │   │   ├── state.rs
│       │   │   │   └── tray.rs
│       │   │   ├── composition.rs
│       │   │   ├── error.rs
│       │   │   ├── lib.rs
│       │   │   ├── main.rs
│       │   │   ├── paths.rs
│       │   │   └── shutdown.rs
│       │   ├── updater/
│       │   │   └── manifest.url
│       │   ├── build.rs
│       │   ├── Cargo.toml
│       │   ├── installer-hooks.nsh
│       │   ├── tauri.conf.json
│       │   ├── tauri.dev.conf.json
│       │   └── tauri.release.conf.json
│       ├── vite-plugins/
│       │   └── custom-error-diagnostics.ts
│       ├── index.html
│       ├── package.json
│       ├── tsconfig.json
│       ├── tsconfig.node.json
│       └── vite.config.ts
├── Architecture/
│   ├── poietica-architecture/
│   │   ├── LAYERS.md
│   │   ├── NAMING.md
│   │   ├── PLACEMENT.md
│   │   ├── REVIEW.md
│   │   └── SKILL.md
│   ├── Appendix A - Target Directory Tree (Actual English Directories, Including Key Single Files).md
│   ├── Appendix B - Target Directory Tree (Pure‑Chinese Modular Semantics).md
│   └── Poietica Overall Architecture Design - Final Modular Reconstruction Plan.md
├── contracts/
│   └── kap/
│       ├── asyncapi.json
│       ├── capabilities.json
│       ├── checksums.json
│       ├── openapi.json
│       └── README.md
├── crates/
│   ├── asset/
│   │   ├── src/
│   │   │   ├── formats.rs
│   │   │   ├── lib.rs
│   │   │   └── registry.rs
│   │   ├── Cargo.toml
│   │   └── CHARTER.md
│   ├── browser/
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   └── picker.rs
│   │   └── Cargo.toml
│   ├── conversation/
│   │   ├── src/
│   │   │   ├── turn/
│   │   │   │   ├── admission.rs
│   │   │   │   ├── cancellation.rs
│   │   │   │   ├── delivery.rs
│   │   │   │   ├── interjection.rs
│   │   │   │   ├── mod.rs
│   │   │   │   └── state_machine.rs
│   │   │   ├── command.rs
│   │   │   ├── error.rs
│   │   │   ├── event.rs
│   │   │   ├── identity.rs
│   │   │   ├── invariants.rs
│   │   │   ├── lib.rs
│   │   │   ├── link.rs
│   │   │   ├── ports.rs
│   │   │   └── projection.rs
│   │   ├── tests/
│   │   │   ├── projection_replay.rs
│   │   │   └── turn_state_machine.rs
│   │   ├── Cargo.toml
│   │   └── CHARTER.md
│   ├── extension/
│   │   ├── src/
│   │   │   ├── error.rs
│   │   │   ├── inventory.rs
│   │   │   ├── layout.rs
│   │   │   ├── lib.rs
│   │   │   ├── skills.rs
│   │   │   ├── source.rs
│   │   │   ├── staging.rs
│   │   │   └── text_file.rs
│   │   └── Cargo.toml
│   ├── git-adapter/
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── review.rs
│   │   │   └── watch.rs
│   │   ├── Cargo.toml
│   │   └── CHARTER.md
│   ├── kap-client/
│   │   ├── src/
│   │   │   ├── connection/
│   │   │   │   ├── handshake.rs
│   │   │   │   ├── mod.rs
│   │   │   │   ├── reconnect.rs
│   │   │   │   └── socket.rs
│   │   │   ├── generated/
│   │   │   │   ├── events.rs
│   │   │   │   ├── GENERATED.md
│   │   │   │   ├── mod.rs
│   │   │   │   └── rest.rs
│   │   │   ├── interaction/
│   │   │   │   ├── desk.rs
│   │   │   │   ├── mod.rs
│   │   │   │   ├── permission.rs
│   │   │   │   └── question.rs
│   │   │   ├── process/
│   │   │   │   ├── controlled_home.rs
│   │   │   │   ├── custom_agents.rs
│   │   │   │   ├── daemon.rs
│   │   │   │   ├── install.rs
│   │   │   │   ├── instance_registry.rs
│   │   │   │   ├── mod.rs
│   │   │   │   ├── profile.rs
│   │   │   │   ├── program.rs
│   │   │   │   ├── stderr_probe.rs
│   │   │   │   └── supervisor.rs
│   │   │   ├── session/
│   │   │   │   ├── book.rs
│   │   │   │   ├── client.rs
│   │   │   │   ├── config.rs
│   │   │   │   ├── coordinator.rs
│   │   │   │   ├── driver.rs
│   │   │   │   ├── mod.rs
│   │   │   │   ├── rest.rs
│   │   │   │   ├── router.rs
│   │   │   │   └── selection.rs
│   │   │   ├── error.rs
│   │   │   ├── frame.rs
│   │   │   ├── history.rs
│   │   │   ├── lib.rs
│   │   │   ├── link.rs
│   │   │   ├── recorder.rs
│   │   │   ├── run_slot.rs
│   │   │   ├── trace.rs
│   │   │   └── translate.rs
│   │   ├── tests/
│   │   │   ├── frame_sink/
│   │   │   │   └── mod.rs
│   │   │   ├── config.rs
│   │   │   ├── live_turn.rs
│   │   │   ├── permission.rs
│   │   │   ├── recorder.rs
│   │   │   ├── session.rs
│   │   │   └── sessions.rs
│   │   ├── Cargo.toml
│   │   └── CHARTER.md
│   ├── ledger/
│   │   ├── src/
│   │   │   ├── conversation/
│   │   │   │   ├── admissions.rs
│   │   │   │   ├── cursors.rs
│   │   │   │   ├── events.rs
│   │   │   │   ├── mod.rs
│   │   │   │   ├── outbox.rs
│   │   │   │   └── screen.rs
│   │   │   ├── index/
│   │   │   │   ├── attachments.rs
│   │   │   │   ├── cursors.rs
│   │   │   │   ├── disposals.rs
│   │   │   │   ├── mod.rs
│   │   │   │   ├── store.rs
│   │   │   │   ├── threads.rs
│   │   │   │   ├── usage.rs
│   │   │   │   └── workbench.rs
│   │   │   ├── migrations/
│   │   │   │   ├── sql/
│   │   │   │   │   ├── 0001_conversation_events.sql
│   │   │   │   │   ├── 0002_turn_admissions.sql
│   │   │   │   │   ├── 0003_delivery_outbox.sql
│   │   │   │   │   ├── 0004_kap_cursors.sql
│   │   │   │   │   ├── 0005_thread_projection.sql
│   │   │   │   │   ├── 0006_local_index.sql
│   │   │   │   │   ├── 0007_admission_skills.sql
│   │   │   │   │   ├── 0008_screen_journal_merge.sql
│   │   │   │   │   └── 0009_run_events_retirement.sql
│   │   │   │   └── mod.rs
│   │   │   ├── projection/
│   │   │   │   ├── mod.rs
│   │   │   │   ├── rebuild.rs
│   │   │   │   └── threads.rs
│   │   │   ├── connection.rs
│   │   │   ├── error.rs
│   │   │   └── lib.rs
│   │   ├── tests/
│   │   │   ├── ledger_roundtrip.rs
│   │   │   └── outbox_idempotency.rs
│   │   ├── Cargo.toml
│   │   └── CHARTER.md
│   ├── problem/
│   │   ├── src/
│   │   │   ├── category.rs
│   │   │   ├── code.rs
│   │   │   ├── diagnostic.rs
│   │   │   ├── lib.rs
│   │   │   ├── problem.rs
│   │   │   ├── redaction.rs
│   │   │   └── retry.rs
│   │   ├── tests/
│   │   │   └── code_table.rs
│   │   ├── Cargo.toml
│   │   └── CHARTER.md
│   ├── process-host/
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   └── program.rs
│   │   └── Cargo.toml
│   ├── review/
│   │   ├── src/
│   │   │   └── lib.rs
│   │   ├── Cargo.toml
│   │   └── CHARTER.md
│   ├── time/
│   │   ├── src/
│   │   │   ├── lib.rs
│   │   │   ├── test_clock.rs
│   │   │   └── wall_clock.rs
│   │   ├── Cargo.toml
│   │   └── CHARTER.md
│   └── update/
│       ├── src/
│       │   ├── bin/
│       │   │   └── payload.rs
│       │   └── lib.rs
│       └── Cargo.toml
├── docs/
│   ├── adr/
│   │   ├── 0001-opaque-window-surface.md
│   │   ├── 0002-unified-fatal-incident.md
│   │   ├── 0003-fatal-escalation-policy.md
│   │   ├── 0004-application-failure-severity.md
│   │   ├── 0005-failure-presentation-hierarchy.md
│   │   ├── 0006-feature-degradation-enforcement.md
│   │   ├── 0007-unified-failure-coordinator.md
│   │   ├── 0008-acp-is-the-only-agent-transport.md
│   │   ├── 0009-acp-client-runs-in-rust.md
│   │   ├── 0010-whole-database-encryption-for-local-ai-state.md
│   │   ├── 0011-no-vendored-shadcn-in-the-agent-feed.md
│   │   ├── 0012-acp-model-and-agent-configuration.md
│   │   ├── 0013-permission-requests-do-not-block-the-dispatch-loop.md
│   │   ├── 0014-concurrent-permission-requests.md
│   │   ├── 0015-approval-lives-with-the-composer.md
│   │   ├── 0016-kimi-runs-on-the-acp-v2-entry.md
│   │   ├── 0017-a-sub-agent-is-one-tool-call.md
│   │   ├── 0018-the-thread-index-is-not-encrypted.md
│   │   ├── 0019-session-fork-is-a-protocol-action.md
│   │   ├── 0020-token-usage-ledger.md
│   │   ├── 0021-deepseek-harness-sdk-wire-transport.md
│   │   ├── 0022-two-agent-transports-one-frame-contract.md
│   │   ├── 0023-the-sdk-line-is-a-subset-of-harness.md
│   │   ├── 0024-one-agent-one-transport.md
│   │   ├── 0025-kimi-code-integrates-over-acp-only.md
│   │   ├── 0026-kap-is-the-only-agent-transport.md
│   │   ├── 0027-the-link-is-a-state-not-a-counter.md
│   │   ├── 0028-the-link-is-a-frame.md
│   │   ├── 0029-prompt-steer-and-queue.md
│   │   ├── 0030-durable-session-execution.md
│   │   ├── 0030-retain-dwm-redirection-surface.md
│   │   ├── 0031-user-agent-files-are-the-customization-source.md
│   │   ├── 0032-the-ledger-is-the-only-truth.md
│   │   └── README.md
│   ├── architecture/
│   │   ├── agent-activity-feed.md
│   │   ├── agent-persistence.md
│   │   ├── data-layout.md
│   │   ├── embedded-browser.md
│   │   ├── kap-client.md
│   │   ├── README.md
│   │   ├── rust-layers.md
│   │   ├── ui-authority-boundaries.md
│   │   └── window-lifecycle.md
│   ├── development/
│   │   └── windows-build-prerequisites.md
│   ├── rfcs/
│   │   ├── 0001-modular-convergence.md
│   │   ├── README.md
│   │   └── thread-owns-sessions.md
│   ├── runbooks/
│   │   ├── desktop-release-checklist.md
│   │   ├── README.md
│   │   └── release-windows.md
│   ├── agent-surface-foundation-review.md
│   └── README.md
├── packages/
│   ├── agent-catalog/
│   │   ├── src/
│   │   │   ├── __tests__/
│   │   │   │   ├── agent-profile-reconcile.test.ts
│   │   │   │   ├── agent-profile.test.ts
│   │   │   │   ├── builtin-agent-seed.test.ts
│   │   │   │   ├── model-display.test.ts
│   │   │   │   ├── provider-presets.test.ts
│   │   │   │   └── provider-state.test.ts
│   │   │   ├── kimi/
│   │   │   │   ├── __tests__/
│   │   │   │   │   ├── catalog-add.test.ts
│   │   │   │   │   ├── catalog.test.ts
│   │   │   │   │   └── descriptor.test.ts
│   │   │   │   ├── catalog-add.ts
│   │   │   │   ├── catalog.ts
│   │   │   │   └── descriptor.ts
│   │   │   ├── agent-descriptor.ts
│   │   │   ├── agent-profile.ts
│   │   │   ├── agents.ts
│   │   │   ├── catalog-codec.ts
│   │   │   ├── catalog-contract.ts
│   │   │   ├── index.ts
│   │   │   ├── model-display.ts
│   │   │   ├── provider-presets.ts
│   │   │   └── provider-state.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── automation/
│   │   ├── src/
│   │   │   ├── automation-gateway.ts
│   │   │   ├── automation-store.ts
│   │   │   ├── automation.test.ts
│   │   │   ├── automation.ts
│   │   │   ├── index.ts
│   │   │   └── templates.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── browser/
│   │   ├── src/
│   │   │   ├── browser-panel-store.ts
│   │   │   ├── browser-port.ts
│   │   │   ├── index.ts
│   │   │   └── viewport-alignment.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── contract/
│   │   ├── src/
│   │   │   └── generated/
│   │   │       └── ipc-bindings.ts
│   │   ├── CHARTER.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── conversation/
│   │   ├── src/
│   │   │   ├── agent/
│   │   │   │   ├── address.ts
│   │   │   │   ├── capability.ts
│   │   │   │   ├── config.ts
│   │   │   │   ├── goal.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── kap.ts
│   │   │   │   ├── link.ts
│   │   │   │   ├── permission.ts
│   │   │   │   ├── question.ts
│   │   │   │   ├── run.ts
│   │   │   │   ├── session.ts
│   │   │   │   ├── thread.ts
│   │   │   │   ├── tool-call.ts
│   │   │   │   ├── toolkit.ts
│   │   │   │   └── usage.ts
│   │   │   ├── interjection/
│   │   │   │   ├── index.ts
│   │   │   │   ├── interjection-contract.ts
│   │   │   │   └── interjection-outbox.ts
│   │   │   ├── session/
│   │   │   │   ├── __tests__/
│   │   │   │   │   ├── agent-capability-store.test.ts
│   │   │   │   │   ├── permission-posture.test.ts
│   │   │   │   │   ├── session-controls-store.test.ts
│   │   │   │   │   └── transcript-store.test.ts
│   │   │   │   ├── agent-capability-store.ts
│   │   │   │   ├── arrival-order.ts
│   │   │   │   ├── describe-failure.ts
│   │   │   │   ├── immutable-map.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── permission-posture.ts
│   │   │   │   ├── session-controls-store.ts
│   │   │   │   ├── thread-order.ts
│   │   │   │   ├── thread-projection.ts
│   │   │   │   ├── thread-title.ts
│   │   │   │   ├── threads-store.ts
│   │   │   │   ├── transcript-sink.ts
│   │   │   │   ├── transcript-store.ts
│   │   │   │   ├── workspace-root.test.ts
│   │   │   │   └── workspace-root.ts
│   │   │   ├── timeline/
│   │   │   │   ├── __fixtures__/
│   │   │   │   │   └── sample-run.ts
│   │   │   │   ├── __tests__/
│   │   │   │   │   ├── batched-frames.test.ts
│   │   │   │   │   ├── compacted-frames.test.ts
│   │   │   │   │   ├── conversation.test.ts
│   │   │   │   │   ├── kap-projection.test.ts
│   │   │   │   │   ├── link-replay.test.ts
│   │   │   │   │   ├── local-error.test.ts
│   │   │   │   │   ├── one-question-one-turn.test.ts
│   │   │   │   │   ├── pending-permission.test.ts
│   │   │   │   │   ├── permission-flow.test.ts
│   │   │   │   │   ├── presentation.test.ts
│   │   │   │   │   ├── prompted-run.test.ts
│   │   │   │   │   ├── renderable.test.ts
│   │   │   │   │   ├── replay-session.test.ts
│   │   │   │   │   ├── replay-session.ts
│   │   │   │   │   ├── span-sharing.test.ts
│   │   │   │   │   ├── terminal-outcome.test.ts
│   │   │   │   │   ├── timeline-reducer.test.ts
│   │   │   │   │   ├── timeline-selectors.test.ts
│   │   │   │   │   └── turn-span.test.ts
│   │   │   │   ├── delegate-channel.ts
│   │   │   │   ├── index.ts
│   │   │   │   ├── kap-projection.ts
│   │   │   │   ├── ordered-lookup.ts
│   │   │   │   ├── presentation.ts
│   │   │   │   ├── projection.ts
│   │   │   │   ├── renderable.ts
│   │   │   │   ├── timeline-contract.ts
│   │   │   │   ├── timeline-draft.ts
│   │   │   │   ├── timeline-queries.ts
│   │   │   │   └── timeline-reducer.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── design-system/
│   │   ├── src/
│   │   │   ├── __tests__/
│   │   │   │   └── theme-contract.test.ts
│   │   │   ├── control/
│   │   │   │   ├── button.tsx
│   │   │   │   ├── command-menu.tsx
│   │   │   │   ├── confirmation-dialog.tsx
│   │   │   │   ├── dialog.tsx
│   │   │   │   ├── dropdown-menu.tsx
│   │   │   │   ├── feedback.tsx
│   │   │   │   ├── popup-surface.ts
│   │   │   │   ├── select.tsx
│   │   │   │   ├── switch.tsx
│   │   │   │   ├── toast.css
│   │   │   │   ├── toast.tsx
│   │   │   │   └── tooltip.tsx
│   │   │   ├── layout/
│   │   │   │   └── region-splitter.tsx
│   │   │   ├── mark/
│   │   │   │   ├── integration-marks/
│   │   │   │   │   ├── automation.svg
│   │   │   │   │   ├── chrome-devtools.svg
│   │   │   │   │   ├── context7.svg
│   │   │   │   │   ├── deepwiki.svg
│   │   │   │   │   ├── docx.svg
│   │   │   │   │   ├── filesystem.svg
│   │   │   │   │   ├── github.svg
│   │   │   │   │   ├── kimi-datasource.svg
│   │   │   │   │   ├── kimi-webbridge.svg
│   │   │   │   │   ├── mcp.svg
│   │   │   │   │   ├── memory.svg
│   │   │   │   │   ├── modern-web-guidance.svg
│   │   │   │   │   ├── pdf.svg
│   │   │   │   │   ├── playwright.svg
│   │   │   │   │   ├── pptx.svg
│   │   │   │   │   ├── sequential-thinking.svg
│   │   │   │   │   ├── skill-creator.svg
│   │   │   │   │   ├── superpowers.svg
│   │   │   │   │   ├── vercel.svg
│   │   │   │   │   └── xlsx.svg
│   │   │   │   ├── file-type-mark.tsx
│   │   │   │   ├── integration-mark.ts
│   │   │   │   ├── local-glyphs.tsx
│   │   │   │   ├── pixel-loader.css
│   │   │   │   └── pixel-loader.tsx
│   │   │   ├── theme/
│   │   │   │   └── theme-controller.ts
│   │   │   ├── tokens/
│   │   │   │   ├── accessibility.css
│   │   │   │   ├── controls.css
│   │   │   │   ├── dark.css
│   │   │   │   ├── layers.css
│   │   │   │   ├── light.css
│   │   │   │   ├── motion.css
│   │   │   │   ├── palette.css
│   │   │   │   ├── radii.css
│   │   │   │   ├── rows.css
│   │   │   │   ├── semantic.css
│   │   │   │   ├── shadows.css
│   │   │   │   └── typography.css
│   │   │   ├── class-names.ts
│   │   │   ├── css.d.ts
│   │   │   ├── index.ts
│   │   │   ├── scrollbar.css
│   │   │   ├── styles.css
│   │   │   ├── surface.css
│   │   │   └── use-copy.ts
│   │   ├── CHARTER.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── extension/
│   │   ├── src/
│   │   │   ├── catalog/
│   │   │   │   ├── builtin-skills.ts
│   │   │   │   ├── builtin.ts
│   │   │   │   ├── listing.ts
│   │   │   │   └── scope.ts
│   │   │   ├── extension-gateway.ts
│   │   │   ├── fetch-plan.test.ts
│   │   │   ├── fetch-plan.ts
│   │   │   ├── index.ts
│   │   │   ├── install-source.test.ts
│   │   │   ├── install-source.ts
│   │   │   ├── installation.ts
│   │   │   ├── manifest-conformance.test.ts
│   │   │   ├── manifest.test.ts
│   │   │   ├── manifest.ts
│   │   │   ├── marketplace.test.ts
│   │   │   ├── marketplace.ts
│   │   │   ├── mcp-config.test.ts
│   │   │   ├── mcp-config.ts
│   │   │   ├── mcp-servers.test.ts
│   │   │   ├── mcp-servers.ts
│   │   │   ├── origin.ts
│   │   │   ├── plugin-store.ts
│   │   │   └── skill.ts
│   │   ├── package.json
│   │   ├── THIRD_PARTY_ICONS.md
│   │   └── tsconfig.json
│   ├── external-store/
│   │   ├── src/
│   │   │   ├── external-store.ts
│   │   │   ├── index.ts
│   │   │   └── preference.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── native-bridge/
│   │   ├── src/
│   │   │   ├── gateways/
│   │   │   │   ├── agent-config-store.ts
│   │   │   │   ├── agent-config.ts
│   │   │   │   ├── agent.ts
│   │   │   │   ├── asset.ts
│   │   │   │   ├── automations.ts
│   │   │   │   ├── browser.ts
│   │   │   │   ├── custom-agents.ts
│   │   │   │   ├── extension.ts
│   │   │   │   ├── git.ts
│   │   │   │   ├── launcher.ts
│   │   │   │   ├── mcp.ts
│   │   │   │   ├── settings.ts
│   │   │   │   ├── update.ts
│   │   │   │   ├── usage.ts
│   │   │   │   ├── workbench.ts
│   │   │   │   └── workspace.ts
│   │   │   ├── platform/
│   │   │   │   ├── app-release.ts
│   │   │   │   ├── data-directory.ts
│   │   │   │   ├── dialog.ts
│   │   │   │   ├── native-crash-report.ts
│   │   │   │   ├── native-window.ts
│   │   │   │   └── paths.ts
│   │   │   ├── error.ts
│   │   │   └── index.ts
│   │   ├── CHARTER.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── problem/
│   │   ├── src/
│   │   │   ├── diagnostics/
│   │   │   │   ├── buffer.test.ts
│   │   │   │   ├── buffer.ts
│   │   │   │   └── log.ts
│   │   │   ├── copy.ts
│   │   │   ├── errors.ts
│   │   │   ├── failure-coordinator.test.ts
│   │   │   ├── failure-coordinator.ts
│   │   │   ├── failure-diagnostic.ts
│   │   │   ├── failure-kernel.test.ts
│   │   │   ├── failure-kernel.ts
│   │   │   ├── index.ts
│   │   │   ├── is-record.ts
│   │   │   ├── optional-property.test.ts
│   │   │   ├── optional-property.ts
│   │   │   └── problem.ts
│   │   ├── CHARTER.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── review/
│   │   ├── src/
│   │   │   ├── change-tree.ts
│   │   │   ├── index.ts
│   │   │   ├── review-gateway.ts
│   │   │   ├── review-store.ts
│   │   │   ├── unified-diff.test.ts
│   │   │   └── unified-diff.ts
│   │   ├── CHARTER.md
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── settings/
│   │   ├── src/
│   │   │   ├── __tests__/
│   │   │   │   └── settings-session.test.ts
│   │   │   ├── custom-agents/
│   │   │   │   ├── agent-document.test.ts
│   │   │   │   ├── agent-document.ts
│   │   │   │   ├── custom-agent-store.ts
│   │   │   │   └── personalization-store.ts
│   │   │   ├── keymap/
│   │   │   │   └── keybinding-catalog.ts
│   │   │   ├── agent-config-store.ts
│   │   │   ├── index.ts
│   │   │   ├── settings-session.ts
│   │   │   ├── settings-store.ts
│   │   │   └── settings.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── surfaces/
│   │   ├── src/
│   │   │   ├── automation/
│   │   │   │   ├── automation-editor.tsx
│   │   │   │   ├── automation-list.tsx
│   │   │   │   ├── automation-run-history.tsx
│   │   │   │   ├── automation-schedule-field.tsx
│   │   │   │   ├── automation-session-config.tsx
│   │   │   │   ├── automations-surface.tsx
│   │   │   │   └── template-gallery.tsx
│   │   │   ├── browser/
│   │   │   │   ├── browser-menu.tsx
│   │   │   │   ├── browser-panel.tsx
│   │   │   │   ├── browser-tab-strip.tsx
│   │   │   │   └── tab-icon.tsx
│   │   │   ├── conversation/
│   │   │   │   ├── __tests__/
│   │   │   │   │   ├── composer-configuration.test.ts
│   │   │   │   │   ├── composer-metrics-contract.test.ts
│   │   │   │   │   ├── conversation-minimap-geometry.test.ts
│   │   │   │   │   ├── mascot-expressions.test.ts
│   │   │   │   │   ├── permission-dock.test.tsx
│   │   │   │   │   ├── prose-streaming.test.tsx
│   │   │   │   │   ├── question-record.test.tsx
│   │   │   │   │   ├── reading-position.test.ts
│   │   │   │   │   ├── session-controls-thinking.test.ts
│   │   │   │   │   ├── thought-line.test.ts
│   │   │   │   │   ├── thread-time.test.ts
│   │   │   │   │   ├── tool-call-content.test.ts
│   │   │   │   │   ├── tool-call-presentation.test.tsx
│   │   │   │   │   ├── tool-duration.test.ts
│   │   │   │   │   └── tool-intent.test.ts
│   │   │   │   ├── composer/
│   │   │   │   │   ├── assistant-composer.tsx
│   │   │   │   │   ├── attachment-intake.ts
│   │   │   │   │   ├── attachment-tray.css
│   │   │   │   │   ├── attachment-tray.tsx
│   │   │   │   │   ├── composer-actions.css
│   │   │   │   │   ├── composer-actions.tsx
│   │   │   │   │   ├── composer-drafts.ts
│   │   │   │   │   ├── composer-metrics.css
│   │   │   │   │   ├── composer-palette.css
│   │   │   │   │   ├── composer-palette.tsx
│   │   │   │   │   ├── context-gauge.css
│   │   │   │   │   ├── context-gauge.tsx
│   │   │   │   │   ├── dock-clearance.ts
│   │   │   │   │   ├── permission-dock.css
│   │   │   │   │   ├── permission-dock.tsx
│   │   │   │   │   ├── permission-picker.css
│   │   │   │   │   ├── permission-picker.tsx
│   │   │   │   │   ├── prompt-chip.css
│   │   │   │   │   ├── prompt-chip.tsx
│   │   │   │   │   ├── prompt-input.tsx
│   │   │   │   │   ├── question-answer.ts
│   │   │   │   │   ├── question-panel.css
│   │   │   │   │   ├── question-panel.tsx
│   │   │   │   │   └── session-controls.tsx
│   │   │   │   ├── feed/
│   │   │   │   │   ├── __tests__/
│   │   │   │   │   │   └── nested-scroll.test.ts
│   │   │   │   │   ├── agent-activity-feed.css
│   │   │   │   │   ├── agent-activity-feed.tsx
│   │   │   │   │   ├── conversation-geometry.ts
│   │   │   │   │   ├── nested-scroll.ts
│   │   │   │   │   ├── reading-position.ts
│   │   │   │   │   └── scroll-authority.ts
│   │   │   │   ├── goal/
│   │   │   │   │   ├── goal-control.ts
│   │   │   │   │   ├── goal-island.css
│   │   │   │   │   └── goal-island.tsx
│   │   │   │   ├── media/
│   │   │   │   │   ├── image-lightbox.css
│   │   │   │   │   └── image-lightbox.tsx
│   │   │   │   ├── minimap/
│   │   │   │   │   ├── conversation-minimap-geometry.ts
│   │   │   │   │   ├── conversation-minimap.css
│   │   │   │   │   ├── conversation-minimap.tsx
│   │   │   │   │   └── use-rail-pointer.ts
│   │   │   │   ├── primitives/
│   │   │   │   │   ├── class-names.ts
│   │   │   │   │   ├── clock.ts
│   │   │   │   │   ├── disclosure.css
│   │   │   │   │   ├── disclosure.tsx
│   │   │   │   │   ├── focus-on-mount.ts
│   │   │   │   │   ├── icons.ts
│   │   │   │   │   ├── motion.ts
│   │   │   │   │   ├── tabs.css
│   │   │   │   │   ├── tabs.tsx
│   │   │   │   │   ├── use-device-pixels.ts
│   │   │   │   │   ├── use-follow-end.ts
│   │   │   │   │   └── use-held-value.ts
│   │   │   │   ├── semantics/
│   │   │   │   │   ├── duration.ts
│   │   │   │   │   ├── file-diff.ts
│   │   │   │   │   ├── tool-call-content.ts
│   │   │   │   │   ├── tool-call-facets.ts
│   │   │   │   │   └── tool-intent.ts
│   │   │   │   ├── session/
│   │   │   │   │   ├── agent-controls-context.ts
│   │   │   │   │   ├── session-controls-context.ts
│   │   │   │   │   ├── transcripts-context.ts
│   │   │   │   │   ├── use-assistant-session.ts
│   │   │   │   │   └── use-running-threads.ts
│   │   │   │   ├── surface/
│   │   │   │   │   ├── mascot/
│   │   │   │   │   │   ├── engine.ts
│   │   │   │   │   │   ├── expressions.ts
│   │   │   │   │   │   ├── mascot-badge.tsx
│   │   │   │   │   │   └── mascot.css
│   │   │   │   │   ├── assistant-surface.tsx
│   │   │   │   │   ├── assistant.css
│   │   │   │   │   ├── prompt-queue.css
│   │   │   │   │   ├── prompt-queue.tsx
│   │   │   │   │   ├── restore-spinner.css
│   │   │   │   │   └── restore-spinner.tsx
│   │   │   │   ├── threads/
│   │   │   │   │   ├── assistant-thread-list.tsx
│   │   │   │   │   ├── git-branch-picker.css
│   │   │   │   │   ├── git-branch-picker.tsx
│   │   │   │   │   ├── relative-time.ts
│   │   │   │   │   ├── thread-disclosure.css
│   │   │   │   │   ├── thread-disclosure.tsx
│   │   │   │   │   └── workspace-picker.tsx
│   │   │   │   └── timeline/
│   │   │   │       ├── delegate-channel-context.ts
│   │   │   │       ├── delegate-channel-view.tsx
│   │   │   │       ├── diagram.tsx
│   │   │   │       ├── error-notice.tsx
│   │   │   │       ├── flow-row.css
│   │   │   │       ├── group-ticker.css
│   │   │   │       ├── group-ticker.tsx
│   │   │   │       ├── link-card.tsx
│   │   │   │       ├── message-attachments.css
│   │   │   │       ├── message-attachments.tsx
│   │   │   │       ├── outcome-card.css
│   │   │   │       ├── outcome-card.tsx
│   │   │   │       ├── plan-panel.tsx
│   │   │   │       ├── prose.tsx
│   │   │   │       ├── question-record.tsx
│   │   │   │       ├── reply-actions.css
│   │   │   │       ├── reply-actions.tsx
│   │   │   │       ├── row-estimate.ts
│   │   │   │       ├── row-rhythm.ts
│   │   │   │       ├── shimmer.css
│   │   │   │       ├── thought-card.tsx
│   │   │   │       ├── thought-line.ts
│   │   │   │       ├── timeline-row.tsx
│   │   │   │       ├── timeline-seat.tsx
│   │   │   │       ├── timeline.css
│   │   │   │       ├── tool-call-card.tsx
│   │   │   │       ├── tool-call-panels.tsx
│   │   │   │       ├── tool-call.css
│   │   │   │       ├── tool-group-card.tsx
│   │   │   │       ├── tool-group.css
│   │   │   │       ├── transcript-view.tsx
│   │   │   │       ├── turn-seal.css
│   │   │   │       ├── turn-seal.tsx
│   │   │   │       └── user-message.tsx
│   │   │   ├── extension/
│   │   │   │   ├── catalog-grid.tsx
│   │   │   │   ├── contribution-list.tsx
│   │   │   │   ├── plugin-browser.tsx
│   │   │   │   ├── plugin-detail.tsx
│   │   │   │   ├── plugin-glyph.tsx
│   │   │   │   ├── plugins-surface.tsx
│   │   │   │   ├── section.tsx
│   │   │   │   └── trust-badge.tsx
│   │   │   ├── review/
│   │   │   │   ├── review-pane.css
│   │   │   │   ├── review-pane.tsx
│   │   │   │   └── syntax.ts
│   │   │   ├── settings/
│   │   │   │   ├── agent-install/
│   │   │   │   │   ├── agent-cli-text.ts
│   │   │   │   │   ├── agent-install-action.tsx
│   │   │   │   │   └── use-agent-install.ts
│   │   │   │   ├── models/
│   │   │   │   │   ├── agent-models.tsx
│   │   │   │   │   ├── models-fields.tsx
│   │   │   │   │   ├── models-settings.css
│   │   │   │   │   ├── models-settings.tsx
│   │   │   │   │   ├── provider-key-card.tsx
│   │   │   │   │   └── use-agent-providers.ts
│   │   │   │   ├── surface/
│   │   │   │   │   ├── archived-chats-settings.css
│   │   │   │   │   ├── archived-chats-settings.tsx
│   │   │   │   │   ├── mascot-prefs.tsx
│   │   │   │   │   ├── segmented-control.tsx
│   │   │   │   │   ├── settings-primitives.tsx
│   │   │   │   │   ├── settings-surface.css
│   │   │   │   │   ├── settings-surface.tsx
│   │   │   │   │   └── use-settings-controller.ts
│   │   │   │   ├── activity-heatmap.tsx
│   │   │   │   ├── keymap-settings.tsx
│   │   │   │   ├── personalization-surface.css
│   │   │   │   ├── personalization-surface.tsx
│   │   │   │   ├── usage-activity.test.ts
│   │   │   │   ├── usage-activity.ts
│   │   │   │   └── usage-settings.tsx
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── update/
│   │   ├── src/
│   │   │   ├── app-update-controller.ts
│   │   │   ├── app-update-store.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── workspace/
│       ├── src/
│       │   ├── command-contract.ts
│       │   ├── command-registry.ts
│       │   ├── index.ts
│       │   ├── surface-registry.test.ts
│       │   ├── surface-registry.ts
│       │   ├── workbench-session-controller.test.ts
│       │   ├── workbench-session-controller.ts
│       │   ├── workbench-tabs-model.test.ts
│       │   ├── workbench-tabs-model.ts
│       │   ├── workbench.ts
│       │   ├── workspace-layout.test.ts
│       │   └── workspace-layout.ts
│       ├── package.json
│       └── tsconfig.json
├── tests/
│   ├── integration/
│   │   └── restart-replay-equivalence.test.ts
│   ├── perf/
│   │   ├── synthetic-conversation.ts
│   │   └── transcript-open.test.ts
│   ├── unit/
│   │   └── architecture/
│   │       └── workspace-dependencies.test.ts
│   ├── package.json
│   ├── README.md
│   └── tsconfig.json
├── tools/
│   ├── architecture/
│   │   ├── charters.ts
│   │   ├── imports.ts
│   │   ├── layering.ts
│   │   ├── policies.ts
│   │   ├── verify.ts
│   │   └── workspace.ts
│   ├── contract/
│   │   ├── check-generated.ts
│   │   ├── check-kap.ts
│   │   ├── generate-ipc.ts
│   │   ├── generate-kap.ts
│   │   └── kap-spec-sync.ts
│   ├── dev/
│   │   ├── clean.ts
│   │   ├── doctor.ts
│   │   └── install-git-hooks.ts
│   ├── release/
│   │   ├── __tests__/
│   │   │   ├── channel.test.ts
│   │   │   ├── manifest.test.ts
│   │   │   └── version.test.ts
│   │   ├── check-versions.ts
│   │   ├── manifest.ts
│   │   ├── release.ts
│   │   ├── set-version.ts
│   │   ├── sign.ts
│   │   ├── verify-channel.ts
│   │   └── version.ts
│   ├── CHARTER.md
│   ├── package.json
│   └── tsconfig.json
├── .gitattributes
├── .gitignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── Cargo.lock
├── Cargo.toml
├── deny.toml
├── LICENSE
├── package.json
├── README.md
├── rust-toolchain.toml
├── tsconfig.base.json
└── turbo.json
```

---
## 三、纯中文目录树（语义镶像）

> 这是第二节那棵树的**语义镶像**，用于沟通与审阅，不作为磁盘目录名（仓库一律英文模块名）。
> 【】里是该模块的四问摘要：我是什么、我拥有什么、谁可调用我、我不许知道什么。
> 粒度：到目录为止，承重文件点名。

```text
诗学工作台（仓库根）
├── 项目宪法【不变量 + 裁决权指针，解释而非定义】
├── 设计文档
│   ├── 总体方案（目标态模块重组计划）
│   ├── 目标态目录树 · 英文实证 ／ 目标态目录树 · 纯中文语义
│   └── 架构守则五件套【分层 / 命名 / 放置 / 评审 / 技能】
│
├── 一、桌面应用【环7 组合根：只做接线与宿主节拍；不裁决业务】
│   ├── 前端根（渲染进程侧）
│   │   ├── 启动页与首帧底色（不闪白；致命屏骨架内联在文档里）
│   │   ├── 引导与装配区
│   │   │   ├── 进程入口（先落主题 → 复原工作台 → 首帧 → 亮窗）
│   │   │   ├── 挂载台与 React 三条错误通道（唯一注入点）
│   │   │   ├── 依赖装配台【把适配实现插到领域插孔，全仓唯一】
│   │   │   ├── React 缺席时的致命屏（自己克隆模板、自己亮窗）
│   │   │   ├── agent 运行时装配 / 附件进门三条路 / 元素拾取器（被单独打包注入子 webview）
│   │   │   ├── 两个 MCP 条目对账（自动化账本、浏览器取点）
│   │   │   ├── 工作目录与思考档位偏好（第一帧就要有值，故走同步存储）
│   │   │   └── 浏览器侧失败采集（含"哪些错误是无害的"白名单）
│   │   ├── 外壳区【工作台骨架】
│   │   │   ├── 主外壳 / 容器分流 / 外壳翻译 / 栅格框 / 停靠位封闭表 / 外壳契约
│   │   │   ├── 表面渲染（渲染表·宿主·图标表；漏一条即编译错误）
│   │   │   ├── 标签条（组合 / 单枚 / 交互 / 视口 / 基线缺口）
│   │   │   ├── 区域布局状态机【侧栏与浏览器共用；跨会话持久化】
│   │   │   ├── 命令区（应用命令表 · 快捷键 · 命令面板）
│   │   │   └── 侧栏区（区域 / 三件套 / 导航 / 底部 / 行样式）
│   │   ├── 对话接线区【AI 表面的唯一渲染出口】
│   │   │   入口与真实对话共用一条管线 · 会话页头（含浏览器开关让位）·
│   │   │   会话进命令面板 · 线程上下文与提供者 · 审阅接线 · 工作区折叠与分支快照
│   │   ├── 内置浏览器接线区【唯一决定"原生 webview 该不该可见"的地方】
│   │   ├── 失败呈现区【失败码 → 影响/文案/恢复动作的唯一策略面】
│   │   │   通知 store（同时最多三张，停留按字数估）· 通知出口 · 错误边界 · 致命屏
│   │   ├── 窗口区（自绘标题栏 · 三枚窗口控件 · chrome hook · 外链归系统 ·
│   │   │        原生右键归零 · 滚动条宽度测量 · 表格另存为）
│   │   ├── 自动化接线区（到期把提示词送进会话；可调项当数据往下交）
│   │   ├── 更新接线区【相位闸：下一步该做什么只有这一处映射】
│   │   └── 样式根（Tailwind 入口 + 桌面平台令牌 + 显式点名第三方产物目录）
│   └── 原生根（Rust / Tauri 侧）
│       ├── 组合根（唯一装配入口）· 磁盘布局唯一声明处 · 唯一退出屏障 · crate 内部错误
│       ├── IPC 面【一份清单三个读者】
│       │   ├── 唯一命令清单 · 绑定导出地址 · 领域错误→Problem（一码一支，无兜底）
│       │   └── 命令族
│       │       ├── 对话（轮次 · 会话线程 · 配置选择器 · 工具箱 · 寻址 · 网关 ·
│       │       │        帧账管线（16ms 攒批 + 先落库再发布）· 附件 · DTO · 失败折叠）
│       │       ├── 资产（导入 · 会话 · 内容寻址 blob 仓）
│       │       ├── 自动化（目录 + 闹钟 · 进程内账本 MCP 服务器）
│       │       ├── agent 接入（档案与凭据 · 封闭白名单执行 · 运行时安装 · 密钥回源探测）
│       │       ├── 扩展（插件 · 一次性目录文档服务 · 技能）
│       │       ├── 工作区（选择根 · 环境 mcp.json · 数据目录 · 表格导出）
│       │       ├── 账本（唯一写者 · 日用量 · 工作台文档存而不解释）
│       │       └── 其他（设置 · 诊断 · 窗口两条 · 更新三步 · git 七条 · 浏览器十四条 · 启动式解析）
│       ├── 窗口面（常驻标识与状态位 · 生命周期与可视区约束 · 托盘与退出契约）
│       ├── 子 webview 面（宿主与标签状态唯一所有者 · 实例生老病死 · 摆放对账 · 拾取回传）
│       ├── 资产协议面（门面 · 请求入口 · Range 识别 · 应答成形）
│       ├── 诊断面（panic 落盘报告 · 结构化日志与第三方降噪）
│       └── 配置与资产（构建期脚本 · 三份应用配置 · 能力与权限清单 · 安装器钩子 · 更新通道 · 图标）
│
├── 二、TS 工作区包（环 0–6）
│   ├── 环0 跨进程契约【唯一生成物；禁手改；谁都能依赖它】
│   ├── 环1 公共词汇
│   │   ├── 失败词汇【只回答"错误是什么"；文案键不由它发明】（含跨语言对账的文案目录）
│   │   └── 外部数据源适配器【只抽样板，不抽状态】
│   ├── 环2 agent 档案【厂商名只允许出现在这里；纯数据 + 只读投影 + 脱敏闸门】
│   ├── 环3 领域（八个包，同环互不引用）
│   │   ├── 对话领域【端口与线上词汇 · 帧→时间线投影（唯一认识协议字段名的 TS 文件）·
│   │   │            插话外发箱 · 线程/转录/可调项/能力四台 store】零 React 零 IO
│   │   ├── 自动化领域【cron 交给库；端口是必填参数】
│   │   ├── 浏览器领域【dock 通道状态 · 子 webview 视口唯一测量处】
│   │   ├── 扩展领域【内置名单 · 清单解码 · 信任档 · 安装流；配置不往下传】
│   │   ├── 审阅领域【统一 diff 语义与行身份；不碰 git 命令】
│   │   ├── 设置领域【端口说领域的语言，不说生成 DTO 的话】
│   │   ├── 更新领域【三步各自失败各自说；节奏常量单源】
│   │   └── 工作台领域【命令注册表是贡献表 · 表面唯一注册处 · 标签数学 · 布局尺寸单源】
│   ├── 环4 原生适配【唯一手写碰宿主 API 的包；只翻译形状，不判对错】
│   │   ├── 网关（按能力命名：会话六端口 · 资产 · 自动化 · 浏览器 · 扩展 · git · 设置 ·
│   │   │        更新 · 用量 · 工作台 · 工作区 · 启动器 · MCP · 自定义 agent · agent 配置）
│   │   └── 平台件（版本 · 数据目录 · 对话框与拖放 · 窗口控制 · 崩溃报告 · 路径 · 一次调用的唯一路）
│   ├── 环5 表现基座【令牌/主题/无业务控件；--ui-* 唯一定义处；不许知道任何领域概念】
│   │   ├── 令牌（原语 · 结构刻度 · 两档主题值 · 语义值 · 可达性策略）
│   │   ├── 控件 / 布局分隔条 / 标记与图形资产 / 主题施加器 / 类名合并
│   ├── 环6 表面视图【六域一包，域边界=目录边界，各域互不引用】
│           ├── 对话表面（输入区全套 · 虚拟滚动流 · 时间线行 · 语义换算 · 会话桥 ·
│           │            外层面板与吉祥物 · 线程清单 · 缩略导航 · 大图预览 · 域内私有件 · 目标岛）
│           ├── 自动化表面 / 浏览器表面 / 扩展表面 / 设置表面（含模型与接入）/ 审阅表面
│
├── 三、原生能力 crate【与宿主无关，可 cargo test 单测】
│   ├── kap 协议适配【帧形状的唯一定义处；进程 · 链路 · 会话 · 帧 · 两张桌子】
│   ├── 本机账本【事件是真相，投影与索引是派生；那一条迁移链】
│   ├── 会话领域核【准入 · 轮次状态机 · 投递记账 · 投影；向外只有两扇门】
│   ├── git 适配器【外调 git 可执行文件；不缓存，真相在磁盘】
│   ├── 审阅模型【porcelain v2 只解释一次；零依赖纯函数】
│   ├── 资产【内容摘要即身份；格式一表三面；交付会话与预算】
│   ├── 浏览器模型【标签页与不变式；能在没有窗口的进程里跑完测试】
│   ├── 扩展落盘【只搬字节；清单内容不归它解释】
│   ├── 进程边缘【GUI 起子进程的三条平台事实，全仓一份】
│   ├── 更新域【载荷格式唯一产出方；校验和签名判据】
│   ├── 错误词汇【21 个码，一码一因；删码即破坏契约】
│   └── 时钟【没有任何地方直接读系统时间】
│
├── 四、协议快照【kap 的自述：REST + 异步 + 能力矩阵 + 校验和；升级后重跑并审 diff】
├── 五、仓库自用工具【架构闸门 · 契约生成与漂移门禁 · 环境体检与清理 · 发布链】
├── 六、跨层测试【重启重放等价 · 性能预算 · 架构依赖】
├── 七、提交与推送关卡【提交前快检 · 推送前全检】
├── 八、流水线关卡【质量 · 供应链安全 · 发布】
├── 九、文档【系统边界 · 已接受决策 · 进行中提案 · 运维手册 · 开发前置】
└── 十、依赖与版本唯一源【原生侧 workspace + 前端侧 catalog】· 风格与任务图 · 工具链钉版
```

---

## 四、架构报告

### 4.1 这个产品是什么

一个本地优先的 Windows 桌面 agent 客户端（0.2.2，NSIS 安装包，`com.poietica.Poietica`）。
唯一接入的 agent 是 Kimi Code 的 TypeScript 版，以 `kimi web --no-open` 拉起 kap 服务，
用 REST 发命令、用单条 WebSocket 收事件。多会话并发是常态。

四条不可协商的形状（都能指向一处代码，不是口号）：

1. **会话是唯一中心** —— 没有绕过会话的第二个入口；屏幕上的对话与 agent 的上下文是两回事。
2. **屏幕上那条经过由本机账本出** —— 每一帧先落库再上屏，重开一条对话就是重放它。
> 落地凭据：`crates/kap-client/src/frame.rs` 定形状，`crates/ledger` 落账，
> `crates/conversation/tests/projection_replay.rs::cold_replay_matches_incremental_apply` 把"重放 ≡ 实时"钉成机器断言。
3. **每类状态只有一个所有者、一条写入路径** —— 影子状态与兜底副本按缺陷处理。
4. **模型输出是不可信输入** —— 渲染层报回来的东西没有一条能直接拼路径或拼命令行。

### 4.2 分层与依赖方向（实测）

**TS 侧八环**（正本在 `tools/architecture/layering.ts`，依赖只能高环指向低环，**同环之间不许有边**）：

| 环 | 名称 | 成员 | 判据要点 |
| --- | --- | --- | --- |
| 7 | composition | `@poietica/desktop`（在 `apps/desktop`） | 唯一装配点 |
| 6 | surfaces | `@poietica/surfaces` | 六域一包，域边界平移为目录边界 |
| 5 | presentation-vocabulary | `@poietica/design-system` | 零仓内依赖；`--ui-*` 令牌唯一定义处 |
| 4 | adapter | `@poietica/native-bridge` | 唯一手写可触 `@tauri-apps/*`（另一个是生成物 contract） |
| 3 | domain | conversation / automation / browser / extension / review / settings / update / workspace | 八包互不引用 |
| 2 | agent-profiles | `@poietica/agent-catalog` | 纯数据档案，被 3/4/6 三层同时消费，故必须更低 |
| 1 | vocabulary | problem / external-store | 零 React |
| 0 | contract | `@poietica/contract` | 生成物，只有一个文件 |

另外三条机器可执行的裁决：`FORBIDDEN_DIRECTORY_NAMES` 封掉 15 个技术种类名与万能桶名
（`utils`/`common`/`components`/`stores`/`types`/`services`…，检查范围 `apps/` + `packages/` 全部目录）；
`FRAMEWORK_FREE_PACKAGES` 12 个包禁 import React；`UNLAYERED_DIRECTORIES = tests, tools`。

**Rust 侧不是"互不依赖"**（`AGENTS.md:56` 的字面描述已过期，见 §7）。实测 6 条 path 依赖边，方向严格单调、无环：

```text
地基（零 workspace 依赖）  problem · time · review · process-host · asset · browser · update · extension
领域核                      conversation ──────────────────────────▶ time
适配环                      ledger ─────▶ conversation, time
                            git-adapter ─▶ process-host, review
协议适配                    kap-client ─▶ conversation, process-host
组合根                      apps/desktop/src-tauri ─▶ 上述 10 个 crate
```

"不依赖 tauri"完全成立：`crates/**/Cargo.toml` 里 tauri 出现 **0 次**，`.rs` 里仅 4 处且全是注释。
唯一沾 `specta` 的是 `problem`（纯类型派生宏，不是 Tauri 运行时）。

### 4.3 IPC 契约面（规模的真实刻度）

`ipc/mod.rs::surface()` 一份清单三个读者，实测：**103 条命令 · 6 个事件 · 76 个注册 DTO · 119 个导出类型**，
生成物 `ipc-bindings.ts` 2,280 行、受版本跟踪。命令按前缀族分布：
对话 22 · 浏览器 14 · 扩展 16（含插件/技能/环境/自定义 agent）· 资产 6 · 自动化 7 · CLI 接入 9 ·
git 7 · 设置 3 · 更新 3 · 账本 3 · 工作区 4 · 窗口 2 · 诊断 1 · 启动器 1 · 工作台 2。

**6 个走生成绑定的事件**：`automation-catalog-changed`、`automation-due`、`browser-element-picked`、
`browser-state`、`update-progress`、`window-maximized`。

**3 个不走生成绑定的裸字符串事件名**（两侧各抄一份，是这条纪律上唯一的例外，值得知道）：
`ai-run-event`（帧批）、`ai-session-event`（选择器表与上下文用量）、`poietica://termination-requested`
（托盘 ↔ `native-window.ts`）。前两个刻意留在生成面之外 —— 载荷是协议原始 JSON，一旦生成绑定就等于
让 TS 侧认识 kap 字段。

**不经 IPC 的窗口动作**：show/hide/minimize/toggleMaximize/close/destroy/setTitle 由
`@tauri-apps/api/window` 直调，权限在 `capabilities/main-window.json` 逐条声明。历史上
`window_destroy` 与 `window_open_devtools` 从未进过 `invoke_handler`，导致退出第一跳每次失败 ——
`commands/window.rs` 的文件头就是这次事故的登记处。

**呈现权在渲染层**：窗口以 `visible:false` 创建；正常路径由 `main.tsx` 在首帧提交后 `present()`；
React 压根没挂上时由 `pre-react-entry.ts` 自己 present；原生兜底是 8 秒看门狗。

### 4.4 数据流与顺序不变量

- **攒批**：`FrameSink` 的契约是**不阻塞**（`try_send` 即答）—— 收帧那一步在 `RunSlot` 锁内、
  驱动器单线程运行时里被调用，睡一下停住的是整条 WS 链路。独立线程 `poietica-frame-journal`
  以 16ms 窗口 ∪ 256 帧上限攒批，队列容量 4096。
- **先落库、再发布**：落库失败按 50ms 起步倍增至 400ms 封顶重试，超限永久失败并计入 `unreported`。
- **发布形状即重放形状**：信封格子（`sessionId`/`seq`/`at`）经 `screen_frame` 并回载荷顶层，
  界面不需要知道账本换过表。
- **两段式**：`Recorder.shape()` 成形在锁外，`deliver()` 投递成功才算用掉序号；
  成形失败的那一帧不投递，序号不前进。同样的形状在 `asset.rs` 的 `materialise`、
  `extension/staging.rs` 的两步装配里各出现一次 —— 这是全仓一致的写法。
- **序号语义分家**：kap 侧 `SeqLine` 按**会话**单调且跨轮次续数，账本 `seq` 按**对话**由
  `max+1` 在同一事务里分配。两套号不互换，界面只见后者。
- **幂等**：`turn_id` 是 `turn_admissions` 主键，`ON CONFLICT DO NOTHING` 的影响行数就是判据
  （0 = 这一轮早被冻结过，不能再欠一次投递）；`delivery_outbox` 允许 `unknown` 是合法状态。

### 4.5 持久化

一个 SQLite 文件（`paths::ledger_database`，实际文件名 `threads.sqlite3`），WAL、
`synchronous=NORMAL`、`foreign_keys=ON`、`busy_timeout=5s`，**全部表 `STRICT`**。rusqlite `bundled`，
**SQLite 层不加密**（ADR 0010 的整库加密已被 0018 取代，0018 现被 0032 的账本论收编）。

迁移链 9 条，只追加、永不修改；运行器除版本号外**还校验迁移名字**（改名等于改已落盘数据的读法）：
0001 事件账 → 0002 准入 → 0003 发件箱 → 0004 kap 游标 → 0005 对话投影 → 0006 九张本机索引表 →
0007 准入带技能 → **0008 帧账并入事件账**（`ROW_NUMBER()` 按线程重排序号，信封格子从载荷剥到列上，
`admissionId` 落进 `turn_id`）→ **0009 `DROP TABLE run_events`**。

当前 **14 张活表**，分界写死在 `ledger/src/index/mod.rs` 头注：
- **事件与派生**：`conversation_events`（真相）、`thread_projection`（删了能重算）；
- **本机索引**（用户与本机的决定，没有事件能重建）：`threads`、`attachments`、`thread_attachments`、
  `workbench_session`、`session_disposals`、`session_usage`、`token_days`、`session_cursors`、
  `turn_admissions`、`delivery_outbox`、`kap_cursors`、`schema_migrations`。
- 附件字节不在库里：按 SHA-256 内容寻址落文件系统，经 `poietica-asset://` 协议交付。
- **顺序即不变量**：存先字节后账本、删先账本后字节，唯一合法中间态"有字节没行"由启动回收清掉。
- `workbench_session` 只存一份不解释的文档（`CHECK (slot = 0)` 让"只有一份"成为结构性的真）。

### 4.6 错误与失败呈现（一套面）

```text
Rust crates/problem：21 个 Code（一码一因，删码即破坏契约）+ 9 类归属 + 3 态可重试性
      + 一张脱敏表（authorization/cookie/credential/key/password/secret/token）+ Uuid v7 诊断号
      → ipc/problem.rs 一码一支、无兜底分支（新增变体在这里编译不过）
      → 跨进程裸 JSON Problem（user_message_key + diagnostic_id）
      → TS native-bridge/error.ts throughIpc()：唯一一条原生调用路，认不出的异常原样上抛
      → packages/problem/copy.ts PROBLEM_COPY 文案目录
      → apps/desktop/notice/problem-presentation.ts：影响等级/文案/恢复动作/作用域全表驱动
      → 四面：recoverable / feature-degraded / application-fatal / native-fatal
      → 非终止：通知卡片（同时最多三张）· 终止：React 致命屏 → React 缺席时 pre-React 致命屏
```

跨语言对账是全仓最硬的一条契约：`PROBLEM_COPY` 的键集必须与 `code.rs` **严格双向相等**，
由 `bun run test:architecture` 执行（多一条少一条都报错）。诊断缓冲 200 条、消息截 2000、
上下文 32 键 × 4000 字符，脱敏与格式化同处；panic hook 把 `NativeCrashReport` 落盘，
下次启动经 `diagnostics_take_previous_crash` 取回并消费。

### 4.7 窗口、进程与生命周期

- **单实例必须是第一个插件**（第二实例 → `tray::show_main()`）。注释给的后果是确定性的：
  带托盘的应用不做单实例 = 第二个托盘图标、两份互相覆写的窗口状态、两个互不知情的文档注册表。
- **退出只有一条路**：`shutdown::on_run_event` 排空屏障 —— 窗口几何落盘 → agent 连接退场
  （送 kap shutdown + 刷完帧日志）→ 放行事件循环，`static DRAINED: AtomicBool` 保证一次。
  托盘"退出程序"、关闭按钮、单实例唤醒都汇入它；托盘另有一项**看得见点得到**的"强制退出（丢弃未保存的更改）"。
- **几何**：`skip_initial_state` + 自行在 `visible:false` 期间恢复，避免"从屏幕中央被挪走"；
  `constrain_to_visible_area` 的存在理由很实在 —— 1400×900 在 1366×768 笔记本上居中会落到 y=-86，
  而窗口无边框、没有原生系统菜单可拖回来，**首次启动就是一个拖不动的窗口**。尺寸上限取显示器 95%。
- **最大化判定在宿主侧做并去抖**（tao 只发 `Resized` 不发 `Maximized`）；渲染层若改成每次问一遍
  `is_maximized`，缩放的每一帧就是一次 IPC 往返。
- **`activate` 刻意不发 `SW_RESTORE`**：它对最大化窗口是"还原到原尺寸"而非空操作，多余的状态变更
  = 一次重新合成 = WebView2 表面未提交时用户看到整窗一闪（ADR 0030-retain-dwm）。
- **DPI 契约不对称**：主窗口几何用 `Physical*`，浏览器子 webview 摆放用 `Logical*` ——
  渲染层量的是 CSS 像素，原生侧不碰 scale factor。
- **进程边缘**：`kimi` 在 Windows 上是 `.cmd` 垫片，所以 `kill_tree` 走 `taskkill /T /F`（单杀垫片
  会把 server 漏在这台机器上）；`hide_console` 全仓一份；裸程序名经 `launcher_resolve` 固化成启动式。
- **等就绪的判据是认令牌，不是文件出现** —— kap server 第一行就 register，那时还没 listen；
  端口被占就 +1，绑上才回填真端口。只信文件就会在这段窗口里拨到别人身上。
- **包管理器归属是查出来的不是猜的**：用 npm 升级一份 pnpm 装的运行时，只会在 npm prefix 里放
  第二个同名垫片，于是"界面说新版本、进程跑旧版本，而且一声不吭"。三家都不是即 `External`，
  这种情况下**一个按钮都不画**。
- **daemon 重启有界**：5 次到顶封版；起来活满 1 分钟即算健康，只在退出时对账，不占定时器；
  退避曲线与链路重连共用 `link.rs` 那一份。

### 4.8 内置浏览器与安全边界

页面本体是主窗口里的**原生子 webview**（`Window::add_child`，需要 cargo feature `unstable`），
不是 iframe —— X-Frame-Options 会把半个互联网挡在外面。React 树里只画壳，
`viewport-alignment.ts` 是全仓唯一的视口测量处（位置变化不触发 ResizeObserver，只能在帧上量，`STILL_FRAMES=2`）。
隔离是结构性的三条：profile 钉在 `browser/profile/`；标签 webview 无 `remote` 声明 → **加载外站 origin
在结构上调不动任何 IPC**；空白页不建 webview。元素拾取脚本由 `build.rs` 用 bun 单独 bundle 成 IIFE
`include_str!` 进宿主，报告落临时文件、只把一行摘要 + 路径回填输入框。

CSP 一行写完：`default-src 'self'`；`script-src 'self'`（**无 unsafe-inline / eval**）；
`style-src 'self' 'unsafe-inline'`；`img-src`/`media-src` 为 `poietica-asset:` 与其 localhost 变体开洞；
`object-src 'none'`；`connect-src` 只允许 IPC 源。资产协议的 `MAX_ASSET_BYTES = 32 MiB`。

密钥一条链：`api_key` 永不经渲染层往返（`AgentLaunch` 不带 argv；`exec` 显式禁 `--api-key`，
因为 Windows 上任何用户都能读到别的进程的完整命令行）；钥匙的整个生命是一次投递
（env → agent 官方 CLI → 它自己的 `config.toml`），下游是明文文件时钥匙串保护不了任何东西；
`provider list --json` 的投影同时是一道脱敏闸门，逐条列出四处可能装明文 key 的位置。
诊断日志有环形缓冲 + 脱敏表，`POIETICA_KAP_TRACE` 只有点名才记，绝不默认开着。

### 4.9 更新通道（自研，不是 tauri-plugin-updater）

`tauri.conf.json` 里 `createUpdaterArtifacts: false` 且**整份配置没有 `plugins` 段**。
自研一条链：`crates/update` 定载荷格式（MAGIC `POIEUP01`，种类写进字节里，解码方不靠文件名猜）、
BLAKE3 成品散列是全链路唯一判据、minisign 签名（与 Tauri 官方签名器同一套实现，仓库里不出现第二套）、
zstd 增量（一行改动的增量 < 目标 1/20）；客户端按基线哈希选增量或整包（semver 判新旧）；
三步动作 `check / download / install` **各自失败各自说**，换装与重启由人按下那一刻决定；
`.staged` / `.outgoing` 两个后缀，旧映像本进程删不掉，下次启动扫。发布端 `poietica-update-payload`
与客户端 apply 同源，`tools/release/*` 读的是同一个 `updater/manifest.url`。

### 4.10 门禁与验证（`bun run check` 到底跑了什么）

```text
check:web   biome ci .                      ← 风格与 lint
      └─ bun tools/architecture/verify.ts   ← 架构闸门（10 条策略 + 宪章判据）
      └─ turbo run typecheck test           ← 全工作区类型与单测
check:rust  cargo fmt --all --check
      └─ cargo clippy --workspace --all-targets --all-features -D warnings
      └─ cargo test --workspace --all-features
      └─ bun run ipc:check                  ← 重生绑定后断言工作区未变
      └─ bun run kap:generated:check        ← kap 生成物对快照
```

架构闸门逐条：`everythingIsRegistered`（新包未定层即失败）、`layerDirection`、`noCycles`、
`publicEntryOnly`（跨包深路径必须出现在对方 exports）、`relativeImportsStayHome`、
`nativeAccessIsDeclared`、`frameworkFreeVocabulary`、`capabilityScopedDirectories`（禁目录名）、
`singleGeneratedContract`、`problemCopyIsComplete`（跨语言文案双向对账）；
宪章类另有 `designSystemOwnsItsTokens`（`--ui-` 只能在 design-system 内定义）、
`noTaskScopedGuards`（全仓禁 TODO/FIXME/@ts-expect-error/biome-ignore）、`noWildcardReExports`。

供应链与发布：`bun audit --audit-level=high` + `cargo deny check --all-features`（`deny.toml`）、
三个 GitHub workflow（quality / security / release）+ 共用 `actions/setup-js`；
`verify:release` = 版本一致 → 全检 → 双审计 → 发布构建。
版本单一真相是 Cargo workspace，`version:set` 一次写四处、其余三处由它派生。

测试分布（可核查）：TS 测试文件 **80** 个（`bun test src`，`packages/conversation` 一家 23 个）；
Rust 集成测试目标 **11** 个（`conversation` 2 · `ledger` 2 · `kap-client` 7）+ 内联 `mod tests` 约 20 处；
跨层 `tests/integration/restart-replay-equivalence.test.ts` 与 `tests/perf/transcript-open.test.ts`。
根 lints 把 panic 纪律压到 warn，并要求**测试逐处写带理由的 allow**（刻意不放 `clippy.toml` 的
allow-expect-in-tests，因为那套开关盖不住集成测试里的辅助方法）。

### 4.11 体量分布

| 区域 | 文件 | 说明 |
| --- | --- | --- |
| `apps/desktop` | 222 | 前端根 82 + 原生根 134 + 根级 6（含 52 个图标） |
| `packages` | 468 | 15 个包；`surfaces` 175、`conversation` 69 为两个最厚的 |
| `crates` | 148 | 118 个 `.rs`（含生成物）+ 9 条 SQL + Cargo.toml + CHARTER |
| `docs` | 52 | 34 条 ADR + 8 篇架构边界 + 3 篇 runbook + 3 篇 RFC |
| `contracts/kap` | 5 | 35,681 行机器自述（协议快照，非人写） |
| `tools` / `tests` / `Architecture` | 27 / 7 / 8 | 闸门、契约工具、发布链；跨层测试；设计与现状文档 |

代码行（ts + tsx + rs）102,589，其中 TS 49,049 / TSX 22,327 / Rust 31,213；CSS 10,075。
**超过 `AGENTS.md:92` 那道 800 行门槛的文件有 11 个**（另加生成物 `ipc-bindings.ts` 2,280 行）：
`mascot/expressions.ts` 2,573（设计稿导出的几何资产，不手改，有测试守形状契约）· `assistant.css` 1,794 ·
`mascot/engine.ts` 1,743 · `transcript-store.ts` 1,143 · `plugin-store.ts` 1,021 · `timeline.css` 960 ·
`kap-projection.ts` 876 · `review-pane.tsx` 874 · `prompt-input.tsx` 825 · `assistant-thread-list.tsx` 811 ·
`settings-surface.tsx` 809。门槛要求"不满足任一拆分判据者，在模块头写明为什么内聚"——
**实测 11 个都带了模块级注释**，只有 `settings-surface.tsx` 的注释落在首个声明之后（形式偏松）。
Rust 侧最大文件 `kap-client/src/session/router.rs` 738 行，全部 crate 都在门槛之内。

### 4.12 术语（读代码前先对齐）

| 术语 | 指什么 | 唯一产地 |
| --- | --- | --- |
| 对话 / thread | 用户眼里的一条会话，可以换过好几轮 agent 会话 | `ledger` 的 `threads` 表（单写者） |
| 会话 / session | agent 那侧的一条活会话，号由它签发，可能跨重启失效 | `kap-client/session/book.rs` |
| 轮次 / turn | 人说一句到这一句结束 | `conversation/turn/state_machine.rs` |
| 准入 / admission | 被冻结的意图（含附件**引用**与技能清单，重试送同一份） | `turn/admission.rs` |
| 帧 / frame | 一轮里发生的一种事 | `kap-client/src/frame.rs`（9 变体） |
| 链路 / link | 连通性状态本身，不是计数、不属于任何一轮 | `conversation/src/link.rs`（策略在 `kap-client/link.rs`） |
| 表面 / surface | 工作台可停靠的一格视图 | `packages/workspace/surface-registry.ts` |
| 工作台 / workbench | 开着哪几格标签，重启后复原 | `workspace` 领域 + `ledger/index/workbench.rs` |
| 插话 / interjection | 一轮在飞时提交下一句：steer 还是排队 | `conversation/interjection/` |
| 账本 / ledger | 本机那份 SQLite，屏幕上唯一经过 | `crates/ledger` |

### 4.13 偏差登记（现状与宪法/文档不一致，按可修成本排序）

宪法 §10 现在写的是"无"，但下列都是实测：

| # | 事实 | 位置 | 代价 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | **干净检出编译不过**：`updater/public.key`（153 B）被 `include_str!` 硬读，但被 `.gitignore` 的 `*.key` 挡住、未受跟踪 | `src-tauri/src/ipc/commands/updates.rs:21` | 阻塞任何新克隆的 release 构建 | 用 `!updater/public.key` 显式放行（公钥不是秘密），或改由环境变量注入 |
| 2 | **未声明依赖**：`packages/workspace` import `valibot`，其 `package.json` 未声明（root catalog 有），当前只靠一份陈旧安装解析 | `packages/workspace/src/workbench-session-controller.ts:1` | 一次 `bun install` 就可能红 | 加 `"valibot": "catalog:"`；顺手删两条声明未用的边（`workspace→problem`、`extension→conversation`） |
| 3 | **宪法正文仍以 `run_events` 为唯一真相**，该表已由迁移 0009 `DROP`，唯一键实为 `conversation_events(thread_id, seq)` | `AGENTS.md` §1/§2、`src-tauri/src/error.rs:10`、`docs/architecture/agent-persistence.md` 整篇（仍以 `crates/persistence` 为主语，该 crate 现名 `ledger`） | 按宪法写代码会去找一张不存在的表 | 修文档；`agent-persistence.md` 与 `adr/0020` 的锚点同步 |
| 4 | **`AGENTS.md:56`「crates 互不依赖」为过期描述**（实测 6 条 path 边，方向单调无环）；"四元结构"全文仅一句且无成员定义 | `crates/*/Cargo.toml` | 误导新代码放置判断 | 把该句改成"互不横向依赖"并按 §4.2 的实证分层重写 |
| 5 | **ADR 0030 一号两文件**（`durable-session-execution` 与 `retain-dwm-redirection-surface`），违反 `docs/adr/README.md` 自己写的"一号一文件、永不复用" | `docs/adr/` | 引 ADR 号会歧义 | 后者改 0033（当前最大号 +1） |
| 6 | **8 份 `src-tauri/permissions/*.json` 全仓零引用**，内容指向的 `fs`/`clipboard-manager` 插件根本不在依赖里；Tauri v2 消费的是 `permissions/*.toml` | `src-tauri/permissions/` | 看着像安全面，其实没人读 | 删（`§1 优先删除代码`） |
| 7 | **`crates/asset` 零测试**（既无 `tests/` 也无内联），而它的 `FORMATS` 判定与令牌/摘要校验正是 §"必须有自有单测"点名的那类判据 | `crates/asset/` | 一张三面表可以安静地坏 | 补 `formats.rs` 与 `registry.rs` 的最简自检 |
| 8 | **注释锚点漂移**：`packages/agent/tool-call` 一类旧包名、`bootstrap/tray.rs`、`bootstrap/app.rs`、`crates/agent-runtime/src/link.rs`（ADR 0027）均已不存在；`time/CHARTER.md` 声称有单调钟，实现只有 `WallClock` | 多处注释 | 违反 §6"锚点必须给当前路径" | 一次性扫注释锚点 |
| 9 | **迁走后的空目录残留**：`packages/automation/src/surface/`、`packages/settings/src/usage/`（未被 git 跟踪） | `packages/` | 无功能影响，读树时是噪音 | 本地删 |
| 10 | `tauri.release.conf.json` 是 `{"bundle": {}}`，实际不改变任何东西；`vite.config.ts` 注释提到"第二份文档入口"，但 `rollupOptions.input` 只有 `index.html` | `apps/desktop/` | 微小误导 | 删或写清 |

### 4.14 扩展路线核对（宪法 §7 承诺的六条，现状是否真走得通）

| 加什么 | 需要动的地方 | 实测结论 |
| --- | --- | --- |
| 一家 agent | `agent-catalog` 加 `<id>/descriptor.ts` + 名单加一行 +（若有目录概念）`CODECS` 加一项；原生侧档案 JSON 字段判据在 `kap-client/process/profile.rs` | **通**。档案是唯一出口，通用层无 `if agent_id == "kimi"`；今天一个钩子都没有（"各家不同的是值→声明字段，不同的是算法→钩子"） |
| 一条 IPC 命令 | `ipc/commands/` 定类型与函数 → 挂进 `surface()` → `bun run ipc:generate` → `native-bridge` 网关适配 | **通**，且 `ipc:check` 会在 CI 上抓到忘记重生绑定 |
| 一种帧 | `frame.rs` 加 variant → `translate.rs` 落领域联合 → TS 侧 `kap-projection.ts` 加一支 | **通**。"每补一个变体，frame.rs 就少一种帧"是写在 translate 头注里的收口方向 |
| 一个包 | 先在 `layering.ts` 定层 | **通**，`everythingIsRegistered` 直接失败 |
| 协议升级 | `bun run kap:spec` 重拍快照 → `kap:generate` → 审 diff | **通**，快照 + checksums + CI diff 门禁三件套都在 |
| 加持久化 | 迁移追加一条（版本号 + 名字 + SQL） | **通**，运行器额外校验名字 |

### 4.15 一句话总评

这套代码最罕见的地方不是分层，而是**判据密度**：几乎每个承重文件头部写的都是"为什么不能那样写"
和"另一份在哪"，而可执行的裁决确实存在（十道架构策略 + 双向文案对账 + 两道生成物漂移门禁 +
"重放 ≡ 实时"的机器断言）。主要风险也来自同一处：**文档与注释的更新速度赶不上代码收敛的速度** ——
`run_events`、`crates/persistence`、"crates 互不依赖"、ADR 0030 重号，四件事都是代码已经收敛、
解释还停在上一站。§4.13 的十条按代价排序，第 1 条是唯一的构建阻塞项。

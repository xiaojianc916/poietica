# 附录 A · 目标目录树（英文实际目录，含关键单文件）

<aside>
📐

这是**目标态**磁盘布局，不是现状。规则：目录名 = 能力，文件名 = 该能力的一个事实；每个模块根带 `CHARTER.md`（四问四行）；`generated/` 不手改；无 `core`/`utils`/`common`/`helpers`，无 `legacy`/`v2`/`new`/`old`；无 `.mjs`。

</aside>

## A.1 仓库顶层

```
poietica/
├── AGENTS.md                          ← 宪法（≤88KiB，只放不变量 + 裁决权指针）
├── CONTEXT.md                         ← 产品与运行环境事实
├── README.md
├── LICENSE
├── Cargo.toml                         ← workspace 成员 + lints + profile（唯一依赖版本源）
├── Cargo.lock
├── rust-toolchain.toml
├── deny.toml                          ← cargo-deny：许可与漏洞门禁
├── package.json                       ← catalog 唯一版本源 + 工作区（含 tools）
├── bun.lock
├── bunfig.toml
├── biome.json
├── turbo.json                         ← typecheck / test / build 任务图
├── tsconfig.base.json
├── tsconfig.json                      ← solution 文件：项目引用 apps/packages/tools/tests
├── .gitattributes
├── .gitignore
├── .githooks/
│   ├── pre-commit                     ← biome + 架构检查（快路径）
│   └── pre-push                       ← typecheck + 单测
├── .github/
│   ├── CODEOWNERS
│   ├── pull_request_template.md
│   └── workflows/
│       ├── quality.yml                ← biome/architecture/typecheck/test/clippy/cargo test
│       ├── contract.yml               ← IPC 与 KAP 生成物漂移门禁
│       ├── performance.yml            ← 预算断言
│       ├── accessibility.yml          ← 键盘/焦点/axe 关键流
│       ├── security.yml               ← bun audit + cargo deny
│       └── release.yml
├── apps/
├── contracts/
├── crates/
├── packages/
├── tools/
├── tests/
└── docs/
```

## A.2 `apps/desktop`：两个组合根

```
apps/desktop/
├── CHARTER.md
├── package.json
├── tsconfig.json
├── vite.config.ts
├── index.html
├── src/                                     ← 前端组合根（R4）：只接线，不裁决
│   ├── entry/
│   │   ├── main.tsx                         ← 入口：读环境 → 装配 → 挂载
│   │   ├── pre-react-entry.ts               ← 首帧不闪白（保留现有能力）
│   │   ├── compose-runtime.ts               ← 唯一 DI 装配点：port ← native-bridge 实现
│   │   └── mount.tsx                        ← React root + 错误边界 + Suspense
│   ├── shell/
│   │   ├── app-shell.tsx                    ← 区域组装（不含业务分支）
│   │   ├── shell-regions.tsx                ← 侧栅/主区/底栈的声明式布局
│   │   ├── region-persistence.ts            ← 布局尺寸持久化（只读写自己的键）
│   │   ├── command-registry.ts              ← 命令注册（来自各领域包的描述符）
│   │   ├── keymap.ts                        ← 快捷键绑定单一产地
│   │   ├── focus-order.ts                   ← tab 序与焦点陷阱
│   │   └── shell.css
│   ├── window/
│   │   ├── title-bar.tsx
│   │   ├── window-controls.tsx
│   │   ├── chrome-metrics.ts                ← 滚动条宽度/安全区域测量
│   │   ├── context-menu-guard.ts            ← 原生右键菜单约束
│   │   └── title-bar.css
│   ├── notice/
│   │   ├── notice-region.tsx                ← 唯一全局提示出口
│   │   ├── problem-presentation.ts          ← Problem → 文案键/动作（无业务分支）
│   │   └── error-boundary.tsx
│   └── styles/
│       ├── app.css
│       └── surfaces.css
└── src-tauri/                               ← 原生组合根（R4）
    ├── CHARTER.md
    ├── Cargo.toml
    ├── build.rs
    ├── tauri.conf.json
    ├── capabilities/
    │   ├── main-window.json                  ← 最小权限集
    │   └── child-webview.json
    ├── icons/
    └── src/
        ├── main.rs                           ← 进程入口（仅调 lib）
        ├── lib.rs                            ← 模块声明
        ├── composition.rs                    ← 唯一装配：crate ← adapter 实例
        ├── shutdown.rs                       ← 关闭顺序（根 CancellationToken）
        ├── paths.rs                          ← 磁盘布局唯一产地
        ├── bin/
        │   └── export-ipc-bindings.rs        ← 生成 TS 绑定的唯一入口
        ├── ipc/
        │   ├── mod.rs                        ← surface()：命令与事件清单唯一一份
        │   ├── problem.rs                    ← 领域错误 → Problem 唯一映射点
        │   ├── events.rs                     ← 事件通道名常量 + 攒批发布器
        │   ├── dto.rs                        ← 领域类型 ↔ 线上类型互转
        │   └── commands/
        │       ├── conversation.rs           ← admitTurn / cancelTurn / respondInteraction
        │       ├── thread.rs                 ← 列表/重命名/归档/删除
        │       ├── transcript.rs             ← 分页读账本
        │       ├── asset.rs                  ← 附件入库/取回
        │       ├── review.rs
        │       ├── workspace.rs
        │       ├── settings.rs
        │       ├── agent_catalog.rs
        │       ├── automation.rs
        │       ├── browser.rs
        │       ├── extension.rs
        │       ├── update.rs
        │       ├── window.rs
        │       └── diagnostics.rs
        ├── window/
        │   ├── lifecycle.rs                  ← 建窗/恢复/关闭拦截
        │   ├── state.rs                      ← 窗口位置与尺寸持久化
        │   ├── tray.rs
        │   └── shortcuts.rs                  ← 全局快捷键注册
        ├── webview/
        │   ├── child_view.rs                 ← 内嵌浏览子 webview（Window::add_child）
        │   ├── bounds.rs                     ← 位置同步（随布局）
        │   └── bridge.rs                     ← 拾取与导航事件转发
        ├── asset_protocol/
        │   ├── handler.rs                    ← 自定义协议入口
        │   ├── response.rs                   ← 响应成形（Content-Type / 缓存头）
        │   └── range.rs                      ← Range 请求处理
        └── diagnostics/
            ├── structured_log.rs            ← 结构化日志 + span
            ├── diagnostic_id.rs             ← 诊断 id 发放与传递
            └── crash_report.rs
```

## A.3 `contracts/`：外部协议真身（只读输入）

```
contracts/
└── kap/
    ├── README.md                  ← 快照来源与升级流程（指向官方端点）
    ├── openapi.json               ← REST 真身快照
    ├── asyncapi.json              ← 事件真身快照
    ├── capabilities.json          ← 能力集矩阵（整数版本协商）
    └── checksums.json             ← 快照指纹（守漂移）
```

## A.4 `crates/`：原生侧四环

```
crates/
├── problem/                                   ← R0
│   ├── CHARTER.md
│   ├── Cargo.toml
│   └── src/
│       ├── lib.rs
│       ├── problem.rs                         ← Problem 结构（唯一定义）
│       ├── category.rs                        ← 九类分类枚举
│       ├── code.rs                            ← 稳定 code 枚举
│       ├── retry.rs                           ← 可重试性语义
│       ├── redaction.rs                       ← 脱敏表（Debug 不打载荷）
│       └── diagnostic.rs                      ← 诊断 id 类型
├── time/                                      ← R0：时钟注入
│   └── src/{lib.rs,wall_clock.rs,monotonic.rs,test_clock.rs,ulid.rs}
├── conversation/                              ← R1 核心领域
│   ├── CHARTER.md
│   ├── Cargo.toml                             ← 无 tokio/rusqlite/reqwest/tauri
│   ├── src/
│   │   ├── lib.rs
│   │   ├── event.rs                           ← ConversationEvent 封闭联合（唯一定义处）
│   │   ├── command.rs                         ← 三条命令的领域入参
│   │   ├── identity.rs                        ← ThreadId / TurnId / Seq 类型
│   │   ├── thread.rs                          ← 线程生命周期与不变量
│   │   ├── turn/
│   │   │   ├── mod.rs
│   │   │   ├── admission.rs                   ← 准入：意图冻结 + 幂等键
│   │   │   ├── state_machine.rs               ← 唯一转移表
│   │   │   ├── delivery.rs                    ← 投递状态（含 unknown）
│   │   │   ├── interjection.rs                ← steer / queue 两种投递语义
│   │   │   ├── boundary.rs                    ← 安全提升边界判定
│   │   │   └── cancellation.rs                ← 取消语义（非错误）
│   │   ├── interaction/
│   │   │   ├── permission.rs                  ← 权限请求与应答
│   │   │   └── question.rs                    ← 提问与选项
│   │   ├── tool_call.rs                       ← 工具调用生命周期
│   │   ├── usage.rs                           ← 用量与配额领域规则
│   │   ├── cursor.rs                          ← 恢复点语义
│   │   ├── projection.rs                      ← 事件 → 快照的纯函数
│   │   ├── invariants.rs                      ← 可执行不变量断言
│   │   └── ports.rs                           ← AgentGateway / EventLedger / Outbox / Clock
│   └── tests/
│       ├── turn_state_machine.rs
│       ├── admission_idempotency.rs
│       ├── interjection_boundary.rs
│       ├── cancellation_propagation.rs
│       ├── event_ordering_proptest.rs
│       └── projection_equivalence.rs
├── review/                                    ← R1
│   ├── src/
│   │   ├── lib.rs
│   │   ├── change_set.rs                      ← 变更集领域模型
│   │   ├── change_tree.rs                     ← 目录树与选择语义
│   │   ├── hunk.rs                            ← 块拆分与行映射
│   │   ├── diff.rs                            ← 差异算法（领域自持）
│   │   ├── draft.rs                           ← 未提交草稿与决策
│   │   ├── commit_intent.rs                   ← 提交意图（不执行 git）
│   │   └── ports.rs                           ← RepositoryReader / FileWriter
│   └── tests/{change_tree.rs,hunk_mapping.rs,draft_conflict.rs}
├── asset/                                     ← R1
│   ├── src/{lib.rs,digest.rs,formats.rs,ingest.rs,retrieval.rs,disposal.rs,ports.rs}
│   └── tests/{formats_table.rs,disposal_order.rs}
├── workspace/                                 ← R1
│   └── src/{lib.rs,root.rs,workbench_session.rs,pane.rs,ports.rs}
├── automation/                                ← R1
│   └── src/{lib.rs,rule.rs,trigger.rs,schedule.rs,run_record.rs,ports.rs}
├── browser/                                   ← R1
│   └── src/{lib.rs,navigation.rs,picker_protocol.rs,session.rs,ports.rs}
├── extension/                                 ← R1（原 plugin-host 的领域部分）
│   └── src/{lib.rs,manifest.rs,inventory.rs,layout.rs,signature.rs,skill.rs,staging.rs,ports.rs}
├── update/                                    ← R1
│   └── src/{lib.rs,channel.rs,manifest.rs,signature.rs,decision.rs,ports.rs}
├── kap-client/                                ← R2 协议适配
│   ├── CHARTER.md
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs
│   │   ├── generated/
│   │   │   ├── GENERATED.md                   ← 生成源与命令（禁手改）
│   │   │   ├── rest.rs                        ← 自 openapi.json
│   │   │   └── events.rs                      ← 自 asyncapi.json
│   │   ├── capability.rs                      ← 整数能力协商（禁版本嗅探）
│   │   ├── process/
│   │   │   ├── supervisor.rs                  ← 子进程生命周期（谁创建谁销毁）
│   │   │   ├── program.rs                     ← 可执行定位（which）
│   │   │   ├── controlled_home.rs             ← 受控 home 与官方 CLI 写入
│   │   │   ├── instance_registry.rs
│   │   │   └── stderr_probe.rs                ← 启动失败诊断
│   │   ├── connection/
│   │   │   ├── handshake.rs
│   │   │   ├── socket.rs                      ← WebSocket 收发（只搞传输）
│   │   │   ├── heartbeat.rs
│   │   │   ├── reconnect.rs                   ← 重连策略
│   │   │   └── backoff.rs
│   │   ├── session/
│   │   │   ├── client.rs                      ← REST 调用（生成客户端之上的薄层）
│   │   │   ├── coordinator.rs                 ← 每线程串行、跳线程并发
│   │   │   ├── prompt_delivery.rs             ← 读发件箱→投递→写终态
│   │   │   ├── cursor.rs
│   │   │   └── resync.rs                      ← 断线后按游标补齐
│   │   ├── translate/
│   │   │   ├── mod.rs                         ← 唯一协议判别式主干
│   │   │   ├── event.rs                       ← wire → ConversationEvent
│   │   │   ├── error.rs                       ← wire 错误 → 领域错误
│   │   │   └── unsupported.rs                 ← 未知事件计数与上报
│   │   └── error.rs
│   └── tests/
│       ├── protocol_conformance.rs            ← 对 kap-fake
│       ├── reconnect_resync.rs
│       ├── delivery_idempotency.rs
│       ├── capability_negotiation.rs
│       └── shutdown_no_orphan.rs
├── kap-fake/                                  ← 仅 dev-dependency：确定性假服务器
│   └── src/{lib.rs,server.rs,scenario.rs,fixtures.rs}
├── ledger/                                    ← R2 事件账本
│   ├── CHARTER.md
│   ├── src/
│   │   ├── lib.rs
│   │   ├── connection.rs                      ← WAL / busy_timeout / foreign_keys 显式设置
│   │   ├── transaction.rs                     ← 事务边界唯一入口
│   │   ├── migrations/
│   │   │   ├── mod.rs                         ← 只追加、已发布不改
│   │   │   └── sql/
│   │   │       ├── 0001_conversation_events.sql
│   │   │       ├── 0002_turn_admissions.sql
│   │   │       ├── 0003_delivery_outbox.sql
│   │   │       ├── 0004_kap_cursors.sql
│   │   │       ├── 0005_threads_projection.sql
│   │   │       ├── 0006_usage_projection.sql
│   │   │       ├── 0007_assets.sql
│   │   │       └── 0008_automation_runs.sql
│   │   ├── conversation/
│   │   │   ├── events.rs                      ← 追加与分页读
│   │   │   ├── admissions.rs
│   │   │   ├── outbox.rs
│   │   │   ├── cursors.rs
│   │   │   └── usage.rs
│   │   ├── projection/
│   │   │   ├── threads.rs                     ← 单写者投影
│   │   │   ├── turn_status.rs
│   │   │   └── rebuild.rs                     ← 从事件重建投影
│   │   ├── asset/{records.rs,disposal.rs}
│   │   ├── automation/records.rs
│   │   ├── workspace/session.rs
│   │   └── error.rs
│   └── tests/
│       ├── crash_consistency.rs
│       ├── migration_replay.rs
│       ├── outbox_exactly_once.rs
│       └── projection_rebuild.rs
├── git-adapter/                               ← R2
│   └── src/{lib.rs,repository.rs,diff_source.rs,apply.rs,watch.rs,error.rs}
└── process-host/                              ← R2：进程与文件系统边缘能力
    └── src/{lib.rs,spawn.rs,pipe.rs,file_lock.rs,watcher.rs,error.rs}
```

## A.5 `packages/`：TS 侧五环

```
packages/
├── contract/                                  ← R0：生成物
│   ├── CHARTER.md
│   ├── package.json
│   └── src/
│       ├── index.ts                           ← 只 re-export 生成类型
│       └── generated/
│           ├── GENERATED.md
│           └── ipc-bindings.ts
├── problem/                                   ← R0
│   └── src/{index.ts,decode.ts,retry-policy.ts,message-key.ts,diagnostic.ts}
├── conversation/                              ← R1：前端会话领域与用例
│   ├── CHARTER.md
│   └── src/
│       ├── index.ts
│       ├── snapshot/
│       │   ├── conversation-snapshot.ts       ← 不可变快照类型
│       │   ├── apply-event.ts                 ← 唯一 reducer（纯函数）
│       │   ├── store.ts                       ← subscribe + 单一 commit 写点
│       │   └── selectors.ts                   ← 记忆化派生视图
│       ├── timeline/
│       │   ├── timeline-model.ts              ← 可渲染项模型（与 UI 无关）
│       │   ├── grouping.ts
│       │   ├── anchors.ts                     ← 滚动锚点与读位
│       │   └── windowing.ts                   ← 虚拟化窗口计算
│       ├── composer/
│       │   ├── draft-model.ts                 ← 草稿领域模型
│       │   ├── attachment-intent.ts
│       │   └── submit-turn.ts                 ← 用例：准入请求成形
│       ├── interaction/{permission.ts,question.ts}
│       ├── thread/{thread-list.ts,thread-title.ts,busy-set.ts}
│       ├── usage/usage-view.ts
│       └── ports/
│           ├── conversation-gateway.ts        ← 命令与订阅接口（由 R4 注入）
│           └── clock.ts
├── review/                                    ← R1
│   └── src/{index.ts,change-tree.ts,selection.ts,draft.ts,syntax-schedule.ts,ports/review-gateway.ts}
├── workspace/                                 ← R1
│   └── src/{index.ts,workbench-session.ts,pane-model.ts,surface-registry.ts,command-descriptor.ts,ports/workspace-gateway.ts}
├── settings/                                  ← R1
│   └── src/{index.ts,settings-view.ts,agent-config-view.ts,keymap-view.ts,model-view.ts,ports/settings-gateway.ts}
├── agent-catalog/                             ← R1：纯数据档案
│   ├── CHARTER.md
│   └── src/
│       ├── index.ts
│       ├── descriptor.ts                      ← 档案形状（只数据）
│       ├── capability-flags.ts                ← 能力开关定义
│       ├── install-spec.ts
│       └── profiles/
│           └── kimi-code.ts                   ← 厂商档案（唯一允许出现厂商名之处）
├── automation/                                ← R1
│   └── src/{index.ts,rule-view.ts,run-history.ts,ports/automation-gateway.ts}
├── browser/                                   ← R1
│   └── src/{index.ts,navigation-model.ts,pick-session.ts,ports/browser-gateway.ts}
├── extension/                                 ← R1
│   └── src/{index.ts,inventory-view.ts,install-flow.ts,skill-view.ts,ports/extension-gateway.ts}
├── update/                                    ← R1
│   └── src/{index.ts,update-state.ts,channel-view.ts,ports/update-gateway.ts}
├── native-bridge/                             ← R2：唯一 @tauri-apps/* 使用者
│   ├── CHARTER.md
│   └── src/
│       ├── index.ts
│       ├── invoke.ts                          ← 命令调用 + Problem 解码
│       ├── subscribe.ts                       ← 事件订阅（含取消注销）
│       ├── gateways/
│       │   ├── conversation-gateway.ts        ← 实现 R1 port
│       │   ├── review-gateway.ts
│       │   ├── workspace-gateway.ts
│       │   ├── settings-gateway.ts
│       │   ├── automation-gateway.ts
│       │   ├── browser-gateway.ts
│       │   ├── extension-gateway.ts
│       │   └── update-gateway.ts
│       └── platform/{window.ts,clipboard.ts,dialog.ts,opener.ts,notification.ts}
├── design-system/                             ← R3
│   ├── CHARTER.md
│   └── src/
│       ├── index.ts
│       ├── tokens/{color.css,space.css,type.css,motion.css,elevation.css}
│       ├── theme/{theme-controller.ts,color-scheme.ts}
│       ├── a11y/{focus-visible.ts,reduce-motion.ts,live-region.tsx}
│       ├── control/{button.tsx,switch.tsx,select.tsx,dropdown-menu.tsx,command-menu.tsx,tooltip.tsx,dialog.tsx,confirmation-dialog.tsx,toast.tsx}
│       ├── layout/{region-splitter.tsx,scroll-area.tsx,virtual-list.tsx}
│       └── mark/{file-type-mark.tsx,integration-mark.tsx,local-glyphs.tsx,pixel-loader.tsx}
├── conversation-ui/                           ← R3
│   └── src/
│       ├── index.ts
│       ├── surface/{conversation-surface.tsx,conversation-header.tsx,empty-state.tsx}
│       ├── timeline/{timeline-view.tsx,virtual-rows.tsx,row-measure.ts,stream-cadence.ts}
│       ├── message/{assistant-text.tsx,reasoning.tsx,tool-call.tsx,attachment.tsx,markdown.tsx}
│       ├── composer/{composer.tsx,attachment-tray.tsx,submit-controls.tsx,interjection-controls.tsx}
│       ├── interaction/{permission-prompt.tsx,question-prompt.tsx}
│       ├── threads/{thread-list.tsx,thread-row.tsx,thread-search.tsx}
│       └── minimap/{minimap.tsx,minimap-model.ts}
├── review-ui/                                 ← R3
│   └── src/{index.ts,review-pane.tsx,change-tree-view.tsx,hunk-view.tsx,decision-controls.tsx,syntax-worker.ts}
├── browser-ui/                                ← R3
│   └── src/{index.ts,browser-dock.tsx,address-bar.tsx,pick-overlay.tsx}
├── settings-ui/                               ← R3
│   └── src/{index.ts,settings-dialog.tsx,agent-section.tsx,keymap-section.tsx,model-section.tsx,usage-section.tsx}
├── automation-ui/                             ← R3
│   └── src/{index.ts,automation-panel.tsx,rule-editor.tsx,run-history-view.tsx}
└── extension-ui/                              ← R3
    └── src/{index.ts,extension-panel.tsx,inventory-view.tsx,install-dialog.tsx}
```

## A.6 `tools/`：全 TypeScript（Bun 原生执行，无 `.mjs`）

```
tools/
├── CHARTER.md
├── package.json
├── tsconfig.json
├── architecture/
│   ├── README.md                          ← 机器执行的那部分架构
│   ├── verify.ts                          ← 唯一入口（bun run test:architecture）
│   ├── ts-graph.ts                        ← TypeScript Compiler API 取依赖图
│   ├── cargo-graph.ts                     ← cargo metadata 取 crate 图
│   ├── layer-policy.ts                    ← 五环/四环方向与无环
│   ├── ownership-policy.ts                ← 单一所有者与同名 store 双导出
│   ├── naming-policy.ts                   ← 禁桶名/禁时间性命名
│   ├── contract-policy.ts                 ← 生成物不手改、协议字面量禁外溢
│   ├── charter-policy.ts                  ← CHARTER.md 存在与登记
│   ├── report.ts                          ← file:line:column 确定性输出
│   └── __tests__/{layer-policy.test.ts,ownership-policy.test.ts,naming-policy.test.ts}
├── contract/
│   ├── generate-ipc.ts                    ← 调 cargo bin 并写 packages/contract
│   ├── generate-kap.ts                    ← spec → crates/kap-client/src/generated
│   ├── kap-spec-sync.ts                   ← 拉取/校验快照（--check）
│   └── check-generated.ts                 ← CI 漂移门禁
├── release/
│   ├── release.ts
│   ├── manifest.ts
│   ├── version.ts
│   ├── check-versions.ts
│   ├── verify-channel.ts
│   ├── sign.ts
│   └── __tests__/{manifest.test.ts,version.test.ts,channel.test.ts}
└── dev/
    ├── clean.ts
    ├── install-git-hooks.ts
    └── doctor.ts                          ← 环境体检（bun/cargo/agent 可用性）
```

## A.7 `tests/`：跨包验收（包内单测不放这里）

```
tests/
├── CHARTER.md
├── package.json
├── tsconfig.json
├── contract/
│   ├── ipc-generation.test.ts             ← 生成物与 Rust 类型一致
│   ├── event-union-exhaustive.test.ts     ← TS 端 never 穷举
│   └── kap-drift.test.ts
├── integration/
│   ├── durable-admission.test.ts
│   ├── delivery-unknown.test.ts
│   ├── restart-replay-equivalence.test.ts ← 实时 ≡ 重放
│   ├── cancel-propagation.test.ts
│   └── ledger-append-failure-stops-stream.test.ts
├── e2e/
│   ├── conversation.spec.ts
│   ├── permission.spec.ts
│   ├── interjection.spec.ts
│   ├── review.spec.ts
│   ├── keyboard-only.spec.ts
│   └── crash-recovery.spec.ts
├── accessibility/
│   ├── axe-critical-flows.spec.ts
│   ├── focus-order.spec.ts
│   └── reduce-motion.spec.ts
├── performance/
│   ├── budgets.json                       ← 预算单一产地
│   ├── transcript-replay.bench.ts
│   ├── streaming-commit.bench.ts
│   ├── review-render.bench.ts
│   └── hidden-window-backlog.bench.ts
└── fixtures/
    ├── ledger/{short-thread.jsonl,long-thread.jsonl,tool-heavy.jsonl}
    ├── kap/{happy-path.json,unknown-event.json,reconnect.json}
    └── review/{small-diff.patch,binary-and-rename.patch}
```

## A.8 `docs/`

```
docs/
├── architecture/
│   ├── README.md                          ← 入口与阅读顺序
│   ├── data-flow.md                       ← 四段一向
│   ├── ledger.md                          ← 账本与不变量
│   ├── kap-boundary.md                    ← 协议边界与能力协商
│   ├── problem-model.md                   ← 错误与取消
│   ├── concurrency.md                     ← 任务树与关闭顺序
│   ├── rendering-budget.md                ← 帧预算与节拍
│   └── module-map.md                      ← 分层表（唯一人读副本，指向可执行策略）
├── adr/
│   ├── 0001-....md
│   └── template.md
├── rfcs/
└── runbooks/{development.md,release.md,incident.md}
```
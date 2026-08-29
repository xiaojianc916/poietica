# 分层：五环与四环

## 判据

- 依赖**只指向更低层**；同层之间不许有边。
- 反向调用（低层要通知高层）一律走 **ports + 订阅**，不许反向依赖。
- `tools/` 与 `tests/` **不进分层**：它们按定义要能引用任何一层。
- 分层表是**事实**，定义在代码里；本文只描述语义，不复制成员清单。

## 可执行产地

| 事实 | 当前路径 |
| --- | --- |
| TS 环序与成员、Cargo 环序与成员 | `tools/architecture/layering.ts` |
| 允许碰 `@tauri-apps/*` 的包 | 同上 `HOST_AWARE_PACKAGES` |
| 不许知道自己跑在 Tauri 里的 crate | 同上 `HOST_AGNOSTIC_CRATES` |
| 不许出现 UI 框架的包 | 同上 `FRAMEWORK_FREE_PACKAGES` / `FRAMEWORK_SPECIFIERS` |
| 禁用的技术种类目录名 | 同上 `FORBIDDEN_DIRECTORY_NAMES` |
| 规则与输出 | `tools/architecture/policies.ts`、`report.ts`；入口 `verify.ts` |

改分层 = 改 `layering.ts`，不是改文档。

## 目标态环序

| 环 | TS 侧 | Rust 侧 | 不许知道 |
| --- | --- | --- | --- |
| R0 公共词汇 | `packages/contract`、`packages/problem` | `crates/problem`、`crates/time` | 任何业务 |
| R1 领域内核 | `packages/conversation`、`review`、`workspace`、`settings`、`agent-catalog`、`automation`、`browser`、`extension`、`update` | `crates/conversation`、`review`、`asset`、`workspace`、`automation`、`browser`、`extension`、`update` | 数据库、协议、窗口、界面 |
| R2 边界适配 | `packages/native-bridge`（全仓唯一 `@tauri-apps/*` 使用者） | `crates/kap-client`、`ledger`、`git-adapter`、`process-host`（+ 仅 dev-dependency 的 `kap-fake`） | 领域内部结构、界面 |
| R3 界面表现 | `packages/design-system`、`conversation-ui`、`review-ui`、`browser-ui`、`settings-ui`、`automation-ui`、`extension-ui` | — | 账本、协议、进程 |
| R4 组合根 | `apps/desktop/src` | `apps/desktop/src-tauri` | 业务规则 |

`packages/agent-catalog` 是 R1 里的纯数据档案：**厂商名只允许出现在档案文件里**。

## 现状与目标的差距

`layering.ts` 里现在是过渡态的环名（foundation / protocol / transport / feature / composition / application），目标态是 R0–R4。判据不变——**单向向下、同层无边、宿主 API 白名单**——变化的是成员归位。重构时以目标态为准，改完同步 `layering.ts` 与 `AGENTS.md` 的指针。

## 中英对照

中文语义视图与磁盘目录的对照表见 `Architecture/Appendix B` 的 B.3 节；**中文名只用于沟通，永不作为目录名**。

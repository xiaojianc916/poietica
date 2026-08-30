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

`layering.ts` 已切到目标态环语义（contract / vocabulary / agent-profiles /
domain / adapter / presentation-vocabulary / surfaces / composition）。
design-system 曾单独成环且低于领域（review 的 store 持有 SplitterActivity
类型）——该类型已归 review 领域自持，design-system 现为表现基座环：零仓内
依赖、只被表现环消费。与目标 R0–R4 的已知偏差（登记在 `layering.ts` 头注释）：

- agent 会话端口与词汇住在 `conversation` 的 `agent/` 目录（原过渡包
  `agent-contract` 已删除）；`agent-catalog` 自成低环；
- `workspace` 已拆分：领域（会话控制器/注册表/标签模型/布局数学）在包内且
  零 React，外壳与停靠视图住在 `apps/desktop/src/shell`（组合根）；
- `@poietica/desktop` 已退出宿主白名单：`native-bridge` 是全仓唯一
  `@tauri-apps/*` 手写使用者。

判据不变——**单向向下、同层无边、宿主 API 白名单**——收敛上述偏差时同步
`layering.ts` 与 `AGENTS.md` 的指针。

## 中英对照

中文语义视图与磁盘目录的对照表见 `Architecture/Appendix B` 的 B.3 节；**中文名只用于沟通，永不作为目录名**。

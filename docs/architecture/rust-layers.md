# Rust Crate 分层

工作区成员见根 `Cargo.toml`。分层表的可执行裁决在
`tools/architecture/layering.ts`（`bun run test:architecture`）；本页是人读副本。

## crates/problem — `poietica-problem`（词汇环）

跨边界错误词汇：Problem 结构、分类、脱敏表。

## crates/time — `poietica-time`（词汇环）

注入式时钟：WallClock / TestClock。

## crates/asset — `poietica-asset`（领域环）

附件与内容寻址：摘要、格式判定表、资产注册表、处置顺序。

## crates/conversation — `poietica-conversation`（领域环）

会话领域：事件联合、轮次状态机、准入/投递/取消不变量、链路态词汇。
无 IO、无运行时、无协议类型。

## crates/review — `poietica-review-native`（领域环）

审查面领域：变更清单、快照、提交意图，以及 porcelain v2 记录的纯解码。
零依赖。

## crates/kap-client — `poietica-kap-client`（适配环）

KAP 协议适配：`generated/`（自 contracts/kap 快照生成，禁手改）、子进程与
实例注册表（process/）、拨号握手重连（connection/）、REST 调用面与事件路由
（session/）、帧的形状与翻译（frame.rs、translate.rs）、审批与提问两张桌子
（interaction/）。

process/ 里还住着 agent 工具链的判读：接入档案字段与 npm 包名闸门
（profile.rs）、config.toml 的读判据与唯一写回路（controlled_home.rs）、
运行时的包管理器归属与安装执行（install.rs）——全部不需要宿主类型，各有单测。

- 依赖 `poietica-conversation` 与 `reqwest`、`tokio-tungstenite`、`futures`、
  `toml_edit`、`which` 等。
- **不依赖 `tauri`**，可用普通 `cargo test` 单独测试。

## crates/ledger — `poietica-ledger`（适配环）

本地 SQLite 账本：连接与事务、迁移（只追加）、追加/分页读、投影表。

## crates/git-adapter — `poietica-git-adapter-native`（适配环）

git 命令适配：分支快照与切换、审查面的执行编排、工作树监视（watch.rs）。
外调 git CLI 而不是 libgit2 —— 分支状态的唯一真相是磁盘上的仓库，只有 git
自己的回答永远与用户在终端里看到的一致。审查面的领域类型与 porcelain 解码
在 `crates/review`，这里只执行与拼装。

- 依赖 `poietica-review-native`、`thiserror`、`tokio`、`notify`。
- **不依赖 `tauri`**。

## crates/extension — `poietica-extension-native`（适配环）

扩展（插件与技能）字节落到磁盘上的那一段：归档解压、目录拷贝、暂存区的开与
认领、原子写、安装盘点（installed.json）。

- 依赖 `tempfile`、`thiserror`、`uuid`、`walkdir`、`zip`。
- **不依赖 `tauri`**。
- 不认识插件清单的内容。唯一解析器是 `packages/extension` 的
  `decodePluginManifest`，原生再解析一遍就会有两套规则 —— 所以这个 crate 交出去
  的是路径与原文，命令层递上来的也是字节与路径。

## crates/browser、crates/update — `poietica-browser-native`、`poietica-update-native`（适配环）

内嵌浏览的拾取协议与发布通道的清单/签名判据。均**不依赖 `tauri`**。

## apps/desktop/src-tauri — `poietica`

唯一的组合根：初始化 Tauri 与插件、建窗、注册命令、持有 native 服务、
在边界上把 IPC DTO 与领域类型互转、把错误映射为稳定的 IPC 错误。

## 规则

- native crate 都不得依赖 `tauri`；领域环（review、conversation、asset）之外
  才允许依赖 IO。
- 命令函数是薄封装，业务分支应下沉到 native crate。
- 领域实体定义在 native crate，不在 `src-tauri`。
- 每个 crate 都必须写 `[lints] workspace = true`，否则工作区的
  `unsafe_code = "deny"` 与 `non_ascii_idents = "forbid"` 对它不生效。

## 已知偏差

（无。曾登记的 `agent_setup/profile.rs`、`agent_setup/install.rs` 超薄封装偏差已
按 §3 判据收敛：档案判读、npm 包名闸门、config.toml 读写与包管理器安装执行住在
`poietica-kap-client` 的 process/ 并有单测；宿主只剩 store 开库、路径与 DTO 互转。）

上面「规则」一节的执行情况：不依赖 `tauri`、必须写
`[lints] workspace = true` 由 `bun run test:architecture` 的
`native-crates-stay-host-agnostic` 执行。「领域实体定义在 native crate，不在
`src-tauri`」与「命令函数是薄封装」**没有机器执行** —— 它们需要语义分析，
所以这里不假装它们被守住了。

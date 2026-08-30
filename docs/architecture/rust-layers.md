# Rust Crate 分层

工作区成员见根 `Cargo.toml`。四个 crate 加一个组合根，依赖单向向下。

## crates/agent-runtime — `poietica-agent-runtime-native`

拥有 agent 进程的驱动：会话生命周期、运行槽、权限请求、帧编解码、
事件记录与 stderr 归集。

- 依赖 `reqwest`、`tokio-tungstenite`、`futures`、`serde`、`serde_json`、
  `thiserror`、`uuid`、`which`。
- **不依赖 `tauri`**，可用普通 `cargo test` 单独测试。

## crates/persistence — `poietica-agent-persistence-native`

拥有本地 SQLite 存储：连接管理、迁移、schema 与线程记录。

- 依赖 `rusqlite`、`serde`、`serde_json`、`time`、`uuid`、`log`。
- **不依赖 `tauri`**。

## crates/plugin-host — `poietica-plugin-host-native`

拥有插件字节落到磁盘上的那一段：归档解压、目录拷贝、暂存区的开与认领、原子写。

- 依赖 `tempfile`、`thiserror`、`uuid`、`walkdir`、`zip`。
- **不依赖 `tauri`**。
- 不认识插件清单的内容。唯一解析器是 `packages/extension` 的
  `decodePluginManifest`，原生再解析一遍就会有两套规则 —— 所以这个 crate 交出去
  的是路径与原文，命令层递上来的也是字节与路径。

## crates/git — `poietica-git-native`

拥有对一个工作目录的 git 分支问答与操作：仓库检测、分支清单、切换、创建并检出。
外调 git CLI 而不是 libgit2 —— 分支状态的唯一真相是磁盘上的仓库，只有 git 自己
的回答永远与用户在终端里看到的一致。

- 依赖 `thiserror`、`tokio`。
- **不依赖 `tauri`**。

## apps/desktop/src-tauri — `poietica`

唯一的组合根：初始化 Tauri 与插件、建窗、注册命令、持有 native 服务、
在边界上把 IPC DTO 与领域类型互转、把错误映射为稳定的 IPC 错误。

## 规则

- native crate 都不得依赖 `tauri`，也不得互相依赖。
- 命令函数是薄封装，业务分支应下沉到 native crate。
- 领域实体定义在 native crate，不在 `src-tauri`。
- 每个 crate 都必须写 `[lints] workspace = true`，否则工作区的
  `unsafe_code = "deny"` 与 `non_ascii_idents = "forbid"` 对它不生效。

## 已知偏差

`src-tauri/src/commands/` 下的 `agent/`、`agent_setup/profile.rs`、
`agent_setup/install.rs` 远超"薄封装"的规模，业务分支尚未下沉到 native crate。
这些偏差没有机器执行的闸门，只靠评审。

上面「规则」一节的四条，目前有三条由 `bun run test:architecture` 的
`native-crates-stay-host-agnostic` 执行：不依赖 `tauri`、互不依赖、必须写
`[lints] workspace = true`。第四条「领域实体定义在 native crate，不在
`src-tauri`」**没有机器执行** —— 它需要语义分析，不是正则或清单判得出来的，
所以这里不假装它被守住了。「命令函数是薄封装」同理。

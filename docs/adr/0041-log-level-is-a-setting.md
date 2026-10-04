# 0041 — 日志级别是设置里的一格，默认 warn

日期：2026-10-04

## 背景

日志闸门从前只有两档实现、没有出口：原生侧 `EnvFilter::new("warn")`（`RUST_LOG` 可覆盖），
主进程 `log.transports.file.level = 'warn'`。用户想看 info/debug 只能起进程时设环境变量，
而打包版根本没有那个入口。

## 决定

1. **级别进设置文档**：`AppSettings.logging.level`，取值 `error | warn | info | debug`，
   **默认 warn**。档位与 tracing 的级别名同名，转 `EnvFilter` 是直译，没有第二张映射表。
   不设 `trace`：全仓没有一处 trace 事件，留一格永远收不到东西的选项是假选择。
2. **改了立即生效，不必重启**。原生侧用 `tracing_subscriber::reload` 拿住闸门，
   `set_level` 只换里面那个 `EnvFilter` —— 订阅器、写入器、轮转全部原地不动。
   主进程侧换 electron-log 两个 transport 的 `level`。
3. **两个进程各有一份套用路径，因为它们的触发点不同**：
   - 原生侧在 `settings_set` / `apply_startup` 里自己套用（它就在那条命令里，不需要绕一圈）。
   - 主进程由渲染层在设置变更时经 `poietica:set-log-level` 推过去 —— 与主题同一分工：
     渲染层是设置的持有者，宿主只接它的结论。
4. **启动时各读一次**。日志出口必须在设置服务与渲染层起来之前就绪：
   - 原生侧：`bootstrap` 直接读 settings.json（`read_log_level`），读不到就是默认 warn。
   - 主进程：`main()` 在建窗之前读同一份文件（`readPersistedSettings`，与主题共用一处解析）。
5. **`RUST_LOG` 仍然优先于设置**。它是排查时的临时覆盖，不该被设置里那一格压过去。
6. **界面在「关于 → 日志」**，与「诊断与更新」并列：它说的是「这软件在背后做什么」，
   与诊断同类，不放在通用页。

## 影响

- `AppSettings` 多一格 `logging`；缺这一格的旧文档按默认值解码，不会整份读不出来。
- 新增 IPC 通道概念（preload 不经过原生命令表）：`poietica:set-log-level`。
  它是主进程能力（换 electron-log 的闸门），与 `poietica:set-theme` / `poietica:set-surface` 同类。
- `log_file.rs` 的 `install` 多一个 `level` 参数，并导出 `set_level`。
- 界面档位只有中文投影，写回设置的是 tracing 的标识符。

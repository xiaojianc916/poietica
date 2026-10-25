# @poietica/feature-terminal

右坞「终端」：在活动工作区运行 shell，`cwd` 缺省为主目录；每终端占标签条一格。

## 职责

- Host 经 `@lydell/node-pty` 启动 PTY，依次找 `pwsh.exe`、`powershell.exe`、`ComSpec`、`cmd.exe`；上限 10 条。
- 输出进 256 KB 环形缓冲，经 8ms 合批以 `terminal.output` 发出，带累计 `offset`；退出前排空尾段。
- `terminal.replay` 返回最近输出与 `endOffset`；渲染进程重载后经 `terminal.list` 接回，按游标去重。
- xterm 按需加载；每终端一个常驻对象，切换标签只换可见 DOM。链接交平台打开。

## 子入口

| 入口       | 内容                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| `contract` | `terminal.*`（open、write、resize、close、list、replay）；通知 `terminal.output`、`terminal.exited` |
| `host`     | PTY、进程清理、环形缓冲与合批、shell 解析、环境清洗                                                 |
| `ui`       | 面板、逐终端标签、加载壳、会话表、xterm 主题                                                        |

## 对外接口

全部方法归 Host（`owner: 'host'`），无 Core 实现与 `ui-api`。

## 边界

- `terminal.close` 杀整棵进程树，Host 退出统一 `disposeAll`；已退出条目在下次 open 时清扫、10 分钟后回收。
- 环境剔除 `ELECTRON_*` / `POIETICA_*` / `NODE_OPTIONS`，注入 `TERM`、`COLORTERM`、`TERM_PROGRAM`。
- 全局 PTY，不属于某条对话；`cwd` 在打开时固定。

快捷键 `` Ctrl+Shift+` `` 新建终端，`` Ctrl+` `` 收起或展开。见 [§4 三个进程与三个微内核](../../docs/ARCHITECTURE.md#4-三个进程与三个微内核)。

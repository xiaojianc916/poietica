# @poietica/feature-platform

平台边界：把应用、窗口、系统对话框、外壳、通知、日志与存储能力收在 Host，并向 UI 提供诊断入口。

## 职责

- **应用与窗口**：提供版本、数据根与打包信息；最小化、最大化 / 还原、关闭、开发者工具与最大化状态通知。窗口位置与尺寸存入 `window-state.json`；保存的坐标不可见时只保留宽高，交给窗口管理器放置。
- **系统外壳**：系统对话框（文件夹、文件、保存路径），以及用默认程序打开链接 / 路径、在资源管理器中定位、移入回收站。`shell.openExternal` 只放行 `http`、`https`、`mailto`；其余外壳操作先校验路径存在。
- **通知与日志**：主窗口聚焦时不弹系统通知，点击后聚焦主窗口并带 `threadId` 发 `notify.clicked`；UI 日志批量写入主日志。
- **存储**：按数据根统计对话、数据库、附件、工具、日志、内核缓存、浏览器数据等占用；默认读上次测量缓存，`refresh` 才全量扫描。可清理缓存、日志与浏览器数据，返回释放字节数。启动后检查 Chromium HTTP 缓存与 V8 代码缓存预算。
- **Core 诊断**：`diagnostics.core` 从 Core 返回实际目录、版本与被清洗的环境变量键；`diagnostics.setLogLevel` 运行时调整 Core 日志级别。

## 子入口

| 入口       | 内容                                                                                |
| ---------- | ----------------------------------------------------------------------------------- |
| `contract` | 平台方法、通知、`AppInfo`、`StorageUsage`、`CoreDiagnostics`、`FileFilter` 与错误码 |
| `core`     | 两个 `diagnostics.*` 方法，读取 Core 运行时与数据布局                               |
| `host`     | 契约中的其余方法；窗口状态、托盘、通知、日志落盘、存储服务、资源图标                |
| `ui`       | 标题栏窗口按钮、Core 失败提示、存储页、关于页、命令与快捷键                         |
| `ui-api`   | `WindowCloseToken`，供其它功能注册关闭前确认                                        |

## 对外接口

方法按命名空间分组：`app.info` / `app.quit`；`window.*`；`dialog.pickFolder` / `pickFiles` / `pickSavePath`；`shell.openExternal` / `openPath` / `showInFolder` / `trashItem`；`notify.show`；`log.write`；`storage.usage` / `clear` / `openDataFolder`；`diagnostics.core` / `setLogLevel`。通知为 `window.maximizedChanged`、`window.closeRequested`、`notify.clicked`。

`WindowCloseToken.onCloseRequested` 收集放行处理器：全部返回 `true` 才调用 `app.quit`，任一处理器抛错按不放行处理。错误码为 `platform.url_not_allowed`、`platform.path_not_found`、`platform.trash_failed`。

## 边界

platform 位于功能分级最底层，不认识任何具体功能；conversation 通过 `WindowCloseToken` 注册关闭前确认，update 通过设置页 `settingsSections` 贡献关于页的一段。托盘、窗口状态与缓存预算只属于 Host；业务数据与清理策略由各数据的主人定义。存储与清理规则见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §7。

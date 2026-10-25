# @poietica/feature-workspaces

工作区登记：把磁盘上的项目目录收进侧栏，维护「当前项目」并作为对话的归属。

## 职责

- **登记**：`workspaces.add` 只接受存在的目录，解析为绝对路径后按归一化 `path_key`（统一小写、去末尾分隔符）去重；同一目录再次添加只更新最近打开时间并返回已有记录。名称默认取路径末段。
- **排序与状态**：`workspaces.list` 按 `last_opened_at` 倒序；每次读取实时检查目录存在性，缺失条目仍保留并显示为失效，不自动移除。`touch` 只更新最近打开时间，不发通知。
- **移除**：`workspaces.remove` 只删除登记，不删除磁盘目录；同时发出 Core 事件 `workspaceRemoved`，conversation 据此级联删除该工作区下的线程。
- **当前项目**：UI 侧 `WorkspacesUi` 持有 `items` 与 `activeId`，`activeId` 本身不持久化；Core 就绪时按最近打开取第一项，切换时调用 `touch`，使下次启动默认选中最后使用的项目。没有项目时 `activeId` 为 `null`，入口页据此禁用发送。
- **添加入口**：`pickAndAdd` 经 platform 的 `dialog.pickFolder` 选择目录，再调用 `workspaces.add`；成功后刷新名单并设为当前项目。

## 子入口

| 入口       | 内容                                                                                  |
| ---------- | ------------------------------------------------------------------------------------- |
| `contract` | `workspaces.list/add/rename/remove/touch`、`workspaces.changed`、`Workspace` 与错误码 |
| `core`     | 路径校验与归一化、SQLite 仓库、目录存在性检查、`workspaceRemoved` 事件                |
| `core-api` | `WorkspacesServiceToken`：`get`、`requireUsable`、`list`；`WorkspaceRemoved` 事件     |
| `ui`       | 名单与当前项 store、添加 / 移除、命令与快捷键；不绘制侧栏组头                         |
| `ui-api`   | `WorkspacesUiToken` 与 `useWorkspacesView`                                            |

## 对外接口

`WorkspacesServiceToken` 面向 Core：`get` 返回记录或 `null`，`requireUsable` 在目录缺失时抛 `workspaces.directory_missing`，`list` 按最近打开排序。`workspaceRemoved` 携带 `workspaceId` 与 `path`，在登记删除后发出。

`WorkspacesUiToken` 面向 UI：`setActive(null)` 回到「还没选项目」；`remove` 不删磁盘目录，当前项目被删除时把 `activeId` 置为 `null`。`useWorkspacesView` 以浅比较订阅名单与当前项，供 conversation 等选择器使用。

错误码为 `workspaces.not_found`、`workspaces.not_a_directory`、`workspaces.directory_missing`。

## 边界

工作区是「项目目录的登记」，不是文件浏览或版本控制：文件树与读取归 files，git 事实归 review。工作区删除后的线程清理由 conversation 响应事件完成；本功能只负责登记、排序与当前项。归属规则见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §7。

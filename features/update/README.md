# @poietica/feature-update

自动更新：检查、下载、安装；状态机在 Host，界面只发动作。

## 职责

- `UpdateState` 七个相位：`disabled`、`idle`、`checking`、`available`、`downloading`、`ready`、`error`；带版本、发布说明、进度、错误与 `lastCheckedAt`。
- Host 以 `electron-updater` 检查、下载（`autoDownload` 关）；安装先完整退出，再 `quitAndInstall(true, true)`；未打包读 `dev-app-update.yml`。
- 横幅显示 `available` / `downloading` / `ready`，下载由人触发；后两档无「稍后」。帮助菜单检查，关于页只留自动检查开关。
- `idle`、从未检查且偏好允许时，十秒后检查一次。

## 子入口

| 入口       | 内容                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `contract` | `update.state`、`update.check`、`update.download`、`update.install`；通知 `update.stateChanged` |
| `host`     | `createUpdateService` 状态机、`UpdaterPort` 适配、`electron-updater` 装配与退出协调             |
| `ui`       | 更新 store、横幅、帮助菜单行、关于页开关、安装确认                                              |

## 对外接口

四个方法全归 Host。`check` 超时 60 秒；`download` 无超时，结果靠 `update.stateChanged`；`download` / `install` 限 `available` / `ready`。

## 边界

- 有对话正在运行时，安装前须确认。
- 相位不允许抛 `update.invalid_phase`；更新器缺席时相位 `disabled`，动作抛 `update.disabled`。
- 「稍后」只在本次运行内记住，不落盘。

见 [§4 三个进程与三个微内核](../../docs/ARCHITECTURE.md#4-三个进程与三个微内核)。

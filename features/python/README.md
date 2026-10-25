# @poietica/feature-python

安装、删除并上报内置 Python 解释器。解释器供 agent 执行代码，安装后把路径写进 agent 设置。

## 职责

- `python.status` 报告 `absent`、`downloading`、`installing`、`ready`、`failed` 五档状态，以及进度、版本与失败信息。
- `python.install` 幂等安装固定版本：依次尝试镜像，校验 SHA-256，解压到暂存目录，运行 `python.exe` 核对版本，再整体换到正式目录；成功后写入 `poietica-python.json` 标记。
- `python.remove` 清空 agent 设置中的解释器并删除整个目录；安装进行中拒绝删除并报 `python.busy`。
- 启动时核对标记、可执行文件与解释器设置：一致则恢复 `ready` 并重申设置；不一致则回到 `absent`，仅当原路径位于本功能目录内才清空。
- 遗留的 `python.staging-*`、`python.old-*` 在启动时清理。

## 子入口

| 入口       | 内容                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------- |
| `contract` | `python.status` / `install` / `remove`、`python.statusChanged`、`PythonStatus` 与 `InstallMarker` |
| `core`     | 安装器（下载、校验、解压、验证、替换）、启动核对、RPC 与状态通知                                  |
| `ui`       | 通用设置页的「运行时」组：状态、安装、重新安装、删除与确认框                                      |

## 对外接口

三条方法与一条通知。安装失败经 `PythonStatus.error` 返回错误码与说明；错误码包括 `python.busy`、`python.download_failed`、`python.checksum_mismatch`、`python.extract_failed`、`python.verify_failed`。

## 边界

本功能只管理自带的那一份解释器。安装包版本、下载地址与校验和钉在 `core/release.ts` 与 `release.generated.ts`；用户已有或系统安装的 Python 不在管理范围内。

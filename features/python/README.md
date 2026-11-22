# @poietica/feature-python

探测、安装并上报本机 Python 解释器。解释器供 agent 执行代码，选中后把路径写进 agent 设置。

## 职责

- `python.status` 报告 `absent`、`outdated`、`downloading`、`installing`、`ready`、`failed` 六档状态，以及版本、解释器路径、进度与失败信息。
- 默认复用系统里正常安装的 Python：`py -0p`、注册表、PATH、`%LOCALAPPDATA%\Programs\Python` 与 Program Files。每个候选都真跑一次 `python -X utf8 -c ...` 验证，注册表里卸载残留的条目在这一步被剔除。uv / Astral 管的解释器不算系统安装（会被 `uv python prune` 清掉），只有用户已经把它配置在 `python.interpreter` 时才沿用。
- `python.install` 幂等：没有可用解释器或版本低于 3.11 时，下载钉住的官方安装包（3.15.2，SHA-256 校验），以当前用户静默安装到系统默认位置并写入用户 PATH；装完重新探测，指向新解释器。
- 启动时清理旧版内置解释器（`tools/python`、`python.staging-*`、`python.old-*`、`python-setup-*`）。没有「删除」：系统 Python 不归产品删。

## 子入口

| 入口       | 内容                                                                |
| ---------- | ------------------------------------------------------------------- |
| `contract` | `python.status` / `install`、`python.statusChanged`、`PythonStatus` |
| `core`     | 探测、安装器（下载、校验、静默安装）、启动核对、RPC 与状态通知      |
| `ui`       | 通用设置页的「运行时」组：状态、安装 / 升级                         |

## 对外接口

两条方法与一条通知。安装失败经 `PythonStatus.error` 返回错误码与说明；错误码包括 `python.download_failed`、`python.checksum_mismatch`、`python.install_failed`、`python.verify_failed`。

## 边界

本功能只管理「agent 用哪一个 Python」：探测本机解释器、必要时安装官方稳定版，并把选中的 `python.exe` 写进 `python.interpreter`。安装包版本、下载地址与校验和钉在 `core/release.ts` 与 `release.generated.ts`。

# 磁盘布局

这个应用在用户机器上占两个根：**程序装在安装目录，数据住在 Electron 的 userData**。
两者分开是硬约束，不是选择 —— 理由见下面「根在哪」。

## 根在哪

| 怎么跑起来 | 数据根 | 谁决定的 |
| --- | --- | --- |
| 安装版 | `%APPDATA%\Poietica` | Electron 的 `app.getPath('userData')`，由 `app.setPath` 钉住 |
| 开发构建 | `%APPDATA%\Poietica Dev` | 同上，未打包时名字多一个后缀 |

唯一的声明处是 `apps/desktop/electron/main.ts` 的 `app.setPath('userData', …)`；
`apps/desktop/native/src/paths.rs` 只在宿主交进来的 `dataRoot` 下面拼各处的名字 ——
原生侧与渲染层都不算路径。

**数据不放在安装目录旁边。** 曾经是那样（判据是 exe 在哪），它与 NSIS 的升级流程直接
冲突：装新版之前，安装器先跑**旧版**的卸载器，而模板在 `--updated` 那一支把 `$INSTDIR`
整个搬进 `$PLUGINSDIR\old-install` 再 `RMDir /r` —— 数据在里面就会被每一次更新清掉。
userData 不在安装器的射程内，这条冲突从根上不存在。

**开发构建另立一个目录。** 数据根就是 userData 之后，两者共用会让开发版与安装版同时
打开同一份账本、同一个 agent 受控 home（0.4.3 之前正是如此）。Chromium 自己的状态
（缓存、分区存储）也跟着这个目录分家。

## 根下面有什么

| 位置 | 是什么 | 删掉会怎样 |
| --- | --- | --- |
| `settings.json` | 主题、语言、快捷键、隐私开关 | 回到默认设置 |
| `agents.json` | agent 接入档案与安装状态缓存 | 内置档案下次启动重新落盘 |
| `automations.json` | 自动化定义 | 自动化全部消失 |
| `ledger.sqlite3` | 本机账本：对话索引、帧日志、附件索引、准入 | 对话列表清空 |
| `attachments/` | 附件字节，内容寻址 | 历史对话里的附件打不开 |
| `agents/<id>/home/` | 各 agent 自己的配置，含 API 密钥 | 需要重新配置 provider |
| `plugins/` | 装进来的插件的托管副本与 `installed.json` | 插件全部回到未安装 |
| `projectless/` | 无项目会话的工作目录根 | 那些会话的工作目录消失 |
| `tools/` | 本应用自己装的工具（内置 Python 解释器） | 下次用到时重新下载 |
| `logs/`、`tmp/`、`cache/` | 日志、暂存、可从上游重取的东西 | 无影响 |

`ledger.sqlite3` 开在 WAL 模式下，磁盘上实际是三个文件：它，加上同名的 `-wal`
与 `-shm`。备份要带上 `-wal`，只拷主文件会丢掉最近一段还没并回去的写入；
`-shm` 不必带，无连接时可安全删除并会被重建。

同一个 userData 目录里还有 Chromium 自己写的东西（`Cache/`、`GPUCache/`、
`Local Storage/`、`Partitions/`、`Preferences` 等）：那不是我们的数据，格式与
生命周期归 Electron，备份时忽略它们。

## 升级

安装器只覆写程序文件，数据在另一个根里，升级碰不到它。升级结束后应用照常从原来的
数据根起来 —— 换版本不换数据根。

旧文件不会被留在安装目录里：模板在升级路径上把 `$INSTDIR` 整个搬走再删掉，
安装器再写进新版的文件。

## 从 ≤0.4.3 升上来

≤0.4.3 的数据根有两处：安装版是 exe 所在目录，开发构建是 `%APPDATA%\Poietica`。
新版第一次启动时会按 `apps/desktop/electron/data-root.ts` 的清单把**还在老位置上的**
状态搬过来，冲突时新根赢，搬完删掉老位置里那一份。

⚠️ **0.4.3 → 第一个修复版这一步，应用救不了自己**：清掉安装目录的是**旧版**的卸载器，
它在新版启动之前就跑完了，那时新版还没有搬迁代码。所以从 ≤0.4.3 升级前要手工把
`$(安装目录)` 里的 `ledger.sqlite3*`、`agents\`、`attachments\`、`settings.json`、
`agents.json` 复制到别处，装完再放进 `%APPDATA%\Poietica`。往后不再需要这一步。

搬迁是一次性的：老位置不会再有新数据，`logs` / `tmp` / `cache` 不搬（丢了能重新长出来），
`tools` 也不搬（60MB 的解释器，用到时重装）。等不再有人从 0.4.3 升上来，那份清单与
搬迁函数一起删。

## 卸载

卸载器只删它自己写进安装目录的文件，数据在 `%APPDATA%\Poietica` 里，普通卸载不会
带走它 —— 程序目录被整体删掉也不会影响下次安装后的对话与设置。

要连数据一起清掉，删掉 `%APPDATA%\Poietica` 这一个目录就是全部；开发构建的数据在
`%APPDATA%\Poietica Dev`，卸载器不认识它。

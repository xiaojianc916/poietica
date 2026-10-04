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
打开同一份账本、同一个 agent 受控 home。Chromium 自己的状态（缓存、分区存储）也跟着
这个目录分家。

## 根下面有什么

| 位置 | 是什么 | 删掉会怎样 |
| --- | --- | --- |
| `settings.json` | 主题、语言、快捷键、隐私开关 | 回到默认设置 |
| `agents.json` | agent 接入档案（一份文档） | 内置档案下次启动重新落盘 |
| `ledger.sqlite3` | 本机账本：对话索引、帧日志、附件索引、准入、用量 | 对话列表与用量清空 |
| `attachments/` | 附件字节，内容寻址 | 历史对话里的附件打不开 |
| `agents/` | agent 自己的 home：配置、会话、技能与插件，含 API 密钥。它自己就是那个 home，没有按 agent 分的第二层（ADR 0042） | 需要重新配置 provider，历史会话读不回来 |
| `plugins/` | 装进来的插件的托管副本与 `installed.json` | 插件全部回到未安装 |
| `projectless/` | 无项目会话的工作目录根 | 那些会话的工作目录消失 |
| `tools/` | 本应用自己装的工具（内置 Python 解释器） | 下次用到时重新下载 |
| `logs/` | 日志。目录由 Electron 的 `app.getPath('logs')` 定（已钉进数据根），两个写入器各一份文件：`poietica.log`（原生侧，tracing-appender 按日轮转留 7 份）与 `main.log`（主进程，electron-log 按 4MB 轮转）。级别由设置里「关于 → 日志 → 记录级别」定，默认 warn、改完即生效。见 ADR 0040、0041 | 无影响 |
| `tmp/`、`cache/` | 暂存、可从上游重取的东西 | 无影响 |
| `automation.lock` | 自动化执行权的排他锁 | 下次启动重新取得 |

`ledger.sqlite3` 开在 WAL 模式下，磁盘上实际是三个文件：它，加上同名的 `-wal`
与 `-shm`。备份要带上 `-wal`，只拷主文件会丢掉最近一段还没并回去的写入；
`-shm` 不必带，无连接时可安全删除并会被重建。

### 为什么只有一个库文件

设置与接入档案是**可手改的文档**，它们留在 `settings.json` 与 `agents.json` 里，一处改一处看。
其余全部是本机账：对话索引、帧账、准入、附件索引、用量、自动化目录 —— 它们同进同出、
要跨表一致，所以住同一个 SQLite 文件。

它的形状只有一份说明：`crates/ledger/src/schema.sql`。**没有版本号表，没有迁移链。**
这个软件还没有发布过，磁盘上不存在别的形状，所以也没有「把旧的补齐」这件事：
改形状 = 改那个文件 + 删掉用户盘上这一个库。真要发版之后再谈迁移。

## 内核那摊子

Chromium 自己写的东西（`Cache/`、`Code Cache/`、`GPUCache/`、`Partitions/`、
`Local State`、`Preferences` 等）不在数据根里，而在 `<数据根>/session/` —— 也就是
Electron 的 `sessionData`，由 `apps/desktop/electron/main.ts` 在 app ready 之前钉住。
那不是我们的数据，格式与生命周期归 Electron；单独放一层是为了让「这个应用占了多大地方」
与「清理该清哪一处」各有单一答案。备份与搬迁都整个忽略 `session/`。

设置页的「存储」一格读的就是这份布局：分类占用由主进程数出来
（`apps/desktop/electron/storage.ts`），可清的两类是内核缓存与内置浏览器数据，
其余只报占用、不开入口 —— 不能清的东西就让它可见。

## 升级

安装器只覆写程序文件，数据在另一个根里，升级碰不到它。升级结束后应用照常从原来的
数据根起来 —— 换版本不换数据根。

旧文件不会被留在安装目录里：模板在升级路径上把 `$INSTDIR` 整个搬走再删掉，
安装器再写进新版的文件。

## 卸载

卸载器只删它自己写进安装目录的文件，数据在 `%APPDATA%\Poietica` 里，普通卸载不会
带走它 —— 程序目录被整体删掉也不会影响下次安装后的对话与设置。

要连数据一起清掉，删掉 `%APPDATA%\Poietica` 这一个目录就是全部；开发构建的数据在
`%APPDATA%\Poietica Dev`，卸载器不认识它。

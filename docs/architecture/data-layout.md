# 磁盘布局

这个应用在用户机器上占的位置只有一个根。

## 根在哪

| 怎么跑起来 | 数据根 | 谁决定的 |
| --- | --- | --- |
| 安装版 | 安装时在目录页选定的那个目录，程序本体也在里面 | 用户 |
| `pnpm tauri dev` | `%LOCALAPPDATA%\\com.poietica.Poietica.dev` | `tauri.dev.conf.json` 里的 identifier |

唯一的声明处是 `apps/desktop/src-tauri/src/paths.rs`。没有第二个地方算路径，
渲染层也不算 —— 关于页面显示的那一行来自 `storage_data_directory`。

安装版把数据放在程序旁边，是因为用户在安装器上只做一次选择，那一次选择就该同时
回答「程序装到哪」和「数据存到哪」。应用侧的判据是可执行文件在哪，所以安装期不
需要写下任何声明 —— 用户把整个目录搬到别的盘，数据跟着一起走。

开发构建不适用这条：exe 在 `target/debug` 下，往那里写用户数据会被 cargo clean
抹掉。开发落点固定在平台目录，identifier 由 `tauri.dev.conf.json` 覆盖成带
`.dev` 后缀的形式，叠加那份配置的是 `scripts/tauri.mjs`，只对 dev 子命令生效。
开发与安装版因此不会同时打开同一个 WAL 库，也不会互相覆盖各自的 settings.json
与 agent 凭据。

## 根下面有什么

| 位置 | 是什么 | 删掉会怎样 |
| --- | --- | --- |
| `settings.json` | 主题、语言、快捷键、隐私开关 | 回到默认设置 |
| `agents.json` | agent 接入档案与安装状态缓存 | 内置档案下次启动重新落盘 |
| `automations.json` | 自动化定义 | 自动化全部消失 |
| `threads.sqlite3` | 对话索引 | 对话列表清空 |
| `attachments/` | 附件字节，内容寻址 | 历史对话里的附件打不开 |
| `agents/<id>/home/` | 各 agent 自己的配置，含 API 密钥 | 需要重新配置 provider |
| `browser/profile/` | 内置浏览器面板的 WebView2 用户数据（Cookie、站点存储） | 面板里的网站登录态消失 |
| `plugins/<id>/` | 装进来的插件的托管副本 | 那个插件的本体消失 |
| `plugins/installed.json` | 装了哪些插件、开没开、哪些 MCP 服务器被关掉 | 插件全部回到未安装 |
| `plugins/marketplace.json` | 上一次拉到的市场目录 | 下次打开市场时重新拉 |
| `plugins/.staging/` | 安装中途的解压暂存区 | 无影响：认领前的中间态 |
| `logs/` | 运行日志与上一次原生崩溃报告 | 无影响 |

安装版的目录里还有程序本体（`Poietica.exe`、`uninstall.exe`、资源），名字与上面
这些都不冲突。升级只覆写程序文件，不碰数据。

`threads.sqlite3` 开在 WAL 模式下，磁盘上实际是三个文件：它，加上同名的 `-wal`
与 `-shm`。备份要带上 `-wal`，只拷主文件会丢掉最近一段还没并回去的写入；
`-shm` 不必带，无连接时可安全删除并会被重建。

## 卸载

卸载器逐个 `Delete` 它自己装进去的文件，最后那句 `RMDir` 不带 `/r` —— 数据
文件还在时它删不掉那个目录，所以普通卸载不会带走数据。

勾了「删除应用数据」才会清干净：`NSIS_HOOK_POSTUNINSTALL` 把整个安装目录递归
删掉。模板自带的那一段清的是平台默认目录，对装到自定义位置的安装没有作用，钩子
补上的正是这一块。升级走的也是卸载流程，`$UpdateMode` 为 1 时一个字节都不动。

## 不在这个根里的东西

两处，都是平台或插件的硬约束，不是选择：

- **窗口位置与尺寸**。`tauri-plugin-window-state` 的落点写死在
  `${dataDir}/${bundleIdentifier}/`，插件没有开放这个参数。
- **WebView2 的缓存**（`EBWebView`）。它归 WebView2 运行时管，位置由宿主进程的
  用户数据目录决定。这不是我们的数据，是浏览器内核的缓存。内置浏览器面板不在此列：它的
  profile 显式钉在数据根的 `browser/profile/` 下，见上表。

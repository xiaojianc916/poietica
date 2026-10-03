# 0031 — 应用数据住 Electron 的 userData，安装器够不着

## 状态

已接受，已落地。改 `apps/desktop/electron/main.ts` 的数据根，并同步
`docs/architecture/data-layout.md`。

## 背景

0.4.2 装上之后，用户的对话、设置与 agent 配置在一夜之间消失。

真因不在应用里，在两条规则的交界处：

1. 安装版的数据根是**程序目录**（`dirname(app.getPath('exe'))`，判据是「exe 在哪，
   数据就在哪」）。
2. electron-updater 装新版之前先跑**旧版**的卸载器（`NsisUpdater.js` 传 `--updated`），
   而 app-builder-lib 的 NSIS 模板在 isUpdated 那一支把 `$INSTDIR` 整个搬进
   `$PLUGINSDIR\old-install`，然后 `RMDir /r $INSTDIR`
   （`templates/nsis/uninstaller.nsh:164-187`）。

数据就住在 `$INSTDIR` 里，于是每一次更新都把用户数据搬走删掉。实测：0.4.3 更新后的
安装目录里，`ledger.sqlite3` 是 4KB 的空库，`threads` 只有 1 行 —— 全部是更新后重建的。

复核时同时看到另外两笔旧账：0.4.2 把安装版的数据根从 `%APPDATA%\Poietica` 改成 exe
旁边，那次换根没有迁移；再往前 Tauri 时代的 `%APPDATA%\@poietica\desktop` 也还留着。
（当时补过一次「从老位置搬过来」的一次性代码；这个软件尚未发布，那份代码与它读的老
位置后来一起删了 —— 盘上不再有需要兼容的数据。）

## 决定

**数据根是 Electron 的 userData**，一处由 `app.setPath('userData', …)` 钉死。
开发构建另立 `%APPDATA%\Poietica Dev`。

### 为什么不修安装器，而把数据搬走

两条路都能让这一次的更新不吃数据，选第二条的理由是它们**能覆盖的范围不一样**：

- 写 `customRemoveFiles` 宏能保住 `$INSTDIR` 里的文件，但它只对**新装上去的**那个卸载器
  生效。用户机器上正在跑的是旧版卸载器，救不了这次，而且以后每换一种安装目标
  （portable、perMachine、换打包器）都要重新证明一遍。
- 数据搬进 userData 之后，安装器与卸载器**从定义上**碰不到它：它们只操作安装目录。
  「安装期不动用户数据」从此不需要我们维护任何宏。

顺带解决的另一件事：装到用户目录的 NSIS 不再需要写 `$INSTDIR` 之外的任何声明，程序
目录可以整体被替换、被删除、被移动，数据照样在。

### 从哪儿来回哪儿去，与旧账

- 安装版：`app.getPath('appData')/Poietica`。
- 开发构建：`app.getPath('appData')/Poietica Dev`，与安装版分家（数据根就是 userData
  之后，共用会让两者同时打开同一份账本与同一个 agent 受控 home）。

### 盘上不留第二份

数据根只有一处（`app.setPath('userData', …)`），启动时只把目录建出来，不读也不搬
任何别的位置 —— 未发布的软件，磁盘上不存在需要兼容的第二份形态。

## 后果

1. 更新不再碰用户数据：换版本只换程序目录里的字节。
2. 用户把程序目录整个删掉再装回来，对话与设置还在。
3. 卸载默认留下数据（与大多数桌面应用一致）；要清干净就删 `%APPDATA%\Poietica`，
   正本写在 `docs/architecture/data-layout.md`。
4. Windows 的「删除应用数据」勾选框与 `NSIS_HOOK_POSTUNINSTALL` 不再需要：那份钩子
   随 Tauri 一起消失后本就没有补回来，现在也不必补 —— 勾选要删的目录不再是安装目录。
5. 数据从程序目录搬走之后，`%APPDATA%\Poietica` 里会重新出现 Chromium 自己的缓存、
   分区存储与窗口位置 —— 那是 Electron 的落点，不是我们的数据。

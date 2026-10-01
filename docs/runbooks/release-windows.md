# Runbook — Windows 发行

面向装到用户电脑上的 Poietica。发布只有一条路径：本机 `bun release` 构建、
签名、上传、验通道，不经过 GitHub Actions。

## 一次性设置

### 更新完整性

Tauri 时代的 minisign 密钥对随宿主一起作废：electron-updater 认的是 sha512 ——
构建时就地算出，写进 `latest.yml`，客户端下完自己核。**因此没有需要保管的私钥，
也就没有「私钥遗失后老客户端无法信任后续更新」这条断头路。**

剩下的发布前置是一条：构建需要本机 Rust 工具链（`rustup show` 能读出
`rust-toolchain.toml` 的那套），原生 `.node` 由它编出来。

### Authenticode 代码签名

未签名安装包会显示“未知发布者”。在 `apps/desktop/electron-builder.yml` 的
`win` 段配置 `certificateFile`/`certificatePassword` 或
`signtoolOptions`；它与上面的 sha512 是两套独立信任链，不能互相替代。

## 发布

```bash
bun release                # 交互选择，默认 patch
bun release minor          # 也可用 patch / major / 具体版本号
bun release 0.3.0 --yes    # 跳过确认
```

命令分十步：起飞前检查（主分支、干净工作区、远端同步、gh 登录、
签名证书）→ 选版本 → 可选完整门禁（`bun run check`，跑在写版本号之前，失败
无需回滚）→ 统一写入三处版本号并一致性检查 → 清空构建目录 → 本地
`build:release` 编译签名（十几分钟）→ 产物进 `dist-release` 并生成
`latest.yml` 与 `SHA256SUMS.txt` → 确认 → 版本提交 + annotated tag +
push → `gh release create` 上传三个资产 → 用客户端真实访问的更新地址验通道。
预发布（版本号带 `-`）发为 prerelease，不进稳定通道、不验通道。

客户端那一侧对得上，靠的是三件事：

- `electron-builder.yml` 的 `publish` 段：它写进包里的 `app-update.yml`，
  客户端真正会去拉的地址由它拼出来。`owner`/`repo` 就是仓库地址的唯一声明。
- `latest.yml`：electron-updater 在 release 页面上按这个名字找清单，
  `tools/release/latest-json.ts` 校验它指向的正是刚构建出来的那个安装包。
- 主进程的更新命令（`apps/desktop/electron/update.ts`）：`update_check` 与
  `update_download` 的相位按版本号对齐，`update_relaunch` 走
  `quitAndInstall()` —— 退出屏障认 `before-quit-for-update` 并放行。

### 失败处理

- 版本提交推出去之前失败：三个版本文件签回原样，仓库干净如初。
- 版本提交推出去之后失败：脚本问你要不要撤回；确认后按 release → 远端 tag →
  本地 tag → 版本号提交的顺序收回，已上远端的提交用 `git revert`，还没上远端
  的直接丢弃。拒绝撤回则保留现场手动处理。
- 任何一步都不 force 覆盖他人提交。

## 安装形态

- 渠道：NSIS，`installMode: currentUser`，不需要 UAC。
- MSI 不与消费者 NSIS 渠道混发；企业渠道需要时独立设计。
- WebView2 使用 `embedBootstrapper`。

## 桌面验收

浏览器测试不能覆盖原生交互。发布前按
`docs/runbooks/desktop-release-checklist.md` 记录被测提交、操作系统与结果。

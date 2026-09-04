# Runbook — Windows 发行

面向装到用户电脑上的 Poietica。发布只有一条路径：本机 `bun release` 构建、
签名、上传、验通道，不经过 GitHub Actions。

## 一次性设置

### 更新签名密钥

```bash
cd apps/desktop && bun run tauri signer generate -w $HOME/.tauri/poietica.key
```

- 公钥写入 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
- 私钥与口令只存本机 `~/.tauri/poietica.key` 与 `~/.tauri/poietica.pass`（首次发布
  时脚本会问一次并记住），另做离线备份；遗失后，已安装客户端无法信任后续更新。
- 构建需要本机 Rust 工具链（`rustup show` 能读出 `rust-toolchain.toml` 的那套）。
- 私钥永不进仓库、永不进 CI。

### Authenticode 代码签名

未签名安装包会显示“未知发布者”。在 `tauri.release.conf.json` 的
`bundle.windows` 中配置 Tauri v2 支持的 `certificateThumbprint` 或
`signCommand`；更新签名与 Authenticode 是两套独立信任链，不能互相替代。

## 发布

```bash
bun release                # 交互选择，默认 patch
bun release minor          # 也可用 patch / major / 具体版本号
bun release 0.3.0 --yes    # 跳过确认（仍会交互问私钥密码，除非已记住）
```

命令分十步：起飞前检查（主分支、干净工作区、远端同步、gh 登录、更新公钥、
签名密钥）→ 选版本 → 可选完整门禁（`bun run check`，跑在写版本号之前，失败
无需回滚）→ 统一写入四处版本号并一致性检查 → 清空构建目录 → 本地
`build:release` 编译签名（十几分钟）→ 产物进 `dist-release` 并生成
`latest.json` 与 `SHA256SUMS.txt` → 确认 → 版本提交 + annotated tag +
push → `gh release create` 上传四个资产 → 用客户端真实访问的更新地址验通道。
预发布（版本号带 `-`）发为 prerelease，不进稳定通道、不验通道。

### 失败处理

- 版本提交推出去之前失败：四个版本文件签回原样，仓库干净如初。
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

## 独立的产品打包缺口

agent 可执行文件仍从终端用户 PATH 解析，安装包未携带 sidecar。该问题不属于发布
编排本身；在解决前，干净 Windows 机器可能成功安装但无法启动 agent 会话。

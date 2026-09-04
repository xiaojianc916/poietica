# Runbook — Windows 发行

面向装到用户电脑上的 Poietica。发布只有一条路径：本地命令创建版本提交与 tag，
GitHub Actions 构建、签名、验收并发布。

## 一次性设置

### 更新签名密钥

```bash
cd apps/desktop && bun run tauri signer generate -w $HOME/.tauri/poietica.key
```

- 公钥写入 `apps/desktop/src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`。
- 私钥与口令只存仓库 secrets：`TAURI_SIGNING_PRIVATE_KEY`、
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。
- 私钥离线备份；遗失后，已安装客户端无法信任后续更新。

### Authenticode 代码签名

未签名安装包会显示“未知发布者”。在 `tauri.release.conf.json` 的
`bundle.windows` 中配置 Tauri v2 支持的 `certificateThumbprint` 或
`signCommand`；更新签名与 Authenticode 是两套独立信任链，不能互相替代。

## 发布

```bash
bun release                       # 交互选择，默认 patch
bun release minor                 # 也可用 patch / major
bun release 0.3.0-rc.1 --no-wait  # 指定版本并在派发后返回
```

命令只确认主分支与干净工作区、同步远端、统一写入四处版本号并做一致性检查，
创建一个版本提交和 annotated tag，再用 `git push --atomic` 一次推送。默认继续等待
Release workflow 完成；`--yes` 仅跳过发布前确认。发布提交由 Quality workflow 执行
唯一一次 `bun run check`；Release workflow 不再重复执行，只保留版本对表、依赖审计、
签名构建与发布。

Release workflow 将 tag 与版本对表并执行依赖审计，然后由官方
`tauri-apps/tauri-action` 构建签名产物和 `latest.json`。Release 在安装冒烟与
Windows GUI 子系统检查通过前保持 draft；通过后自动发布、标记 latest，并验证稳定更新端点。
预发布版本会发布为 prerelease，但不会替换稳定更新端点。

### 失败处理

- 原子推送前失败：命令删除自己创建的 tag/提交并恢复四个版本文件。
- 原子推送后任一步失败或取消：Release workflow 的失败清理步骤撤回远端副作用。若版本
  文件仍由本次发布拥有，则以 `git revert` 保留审计历史并恢复上一版本；随后原子删除 tag，
  并删除对应 draft/已发布 Release。若后续版本已接管版本文件，只删除本次 tag/Release。
- 回滚发生冲突、权限不足或并发 push 时明确失败，不 force 覆盖其他提交。

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

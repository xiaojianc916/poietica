# @poietica/feature-review

右坞「审查」面板看工作树，侧栏「代码审查」页看 GitHub pull request。

## 职责

- `git.review` / `git.filePatch` 按需读取改动与补丁，`DiffBody` 绘制统一 diff；支持筛选、变更文件树与文字差异。
- 提交经 `git.commit`（`stageAll` 即 `git add -A`），分支切换与新建走 `git.switchBranch` / `git.createBranch`。
- GitHub 侧按远端识别 `owner/name`；列表取摘要，正文、检查项与评论按需读取；支持评论、Draft 切换与 merge / squash / rebase 合并。
- `git.watch` 按工作区引用计数，Core 重启后重发；同一份 Git 事实经贡献点供状态面板与分支 chip 使用。

## 子入口

| 入口       | 内容                                                              |
| ---------- | ----------------------------------------------------------------- |
| `contract` | `git.*`、`github.*`；通知 `git.changed`                           |
| `core`     | git 调用与错误翻译；GitHub 直连客户端（GraphQL + REST）；仓库监听 |
| `ui`       | 审查面板、代码审查页、分支 chip 与 Git 工具事实源                 |

## 对外接口

无 `ui-api`。调用经 `contract` 取类型；除 `github.availability` 外，RPC 按 `workspaceId` 寻址，组合根固定进 `createReviewApi`。

## 边界

- 不是仓库时 `git.status` 返回 `isRepo: false`；远端不在 GitHub 时 `repository` 为 `null`。
- GitHub 凭据读 `GH_TOKEN` / `GITHUB_TOKEN`、`gh auth token`、`git credential fill`；不可用由 `github.availability` 说明。
- `git.stage` / `git.unstage` 暂无界面消费者；面板不提供还原或丢弃。

见 [§4 三个进程与三个微内核](../../docs/ARCHITECTURE.md#4-三个进程与三个微内核)。

# ADR-010：工作区、影子 Checkpoint 与写租约

状态：通过；P5 已落地影子仓库、检查点事件、写租约与隔离 worktree 的侧栏入口。

背景：旧撤销只认 5 个写工具，shell、脚本、构建与 MCP 写入无法回滚；两个 Thread 并行写同一目录也没有仲裁。

决策：

- 每个工作区一个影子 git 仓库，放在应用数据目录，以用户工作目录为 work-tree，不动用户的 `.git`、分支与 stash。
- 轮次开始必打检查点；每次写型工具步骤与用户手动打点追加增量点（当前先落轮次开始）。
- 检查点是 Journal 一等事件 `checkpoint.created`，带工作区与原因。
- 恢复按显式路径执行，恢复前用 `git status --porcelain` 检测检查点之后的手动改动；冲突整次拒绝。
- 恢复本身再打一个 `revert` 检查点，支持「撤销的撤销」。
- 每个工作区一个写租约，同一时刻只允许一个 Thread 持有；同 Thread 重入续期，过期自动释放。
- 隔离模式使用独立 git worktree；交付支持把 worktree 相对基线的补丁应用到主工作区，三方合并失败返回原因而不是半写。

后果：

- 快照覆盖 shell 与脚本写入；无 git 时可退回目录副本（尚未实现）。
- 影子仓库占用应用数据目录；大文件阈值与排除规则仍需补齐。
- 内置 omp 工具与 shell / 脚本的写入都随步骤结束的整树快照进入检查点。

## 实施进度（2026-11-15）

- 每轮固定打「轮次开始」（提交前）与「轮次结束」（turnSettled）；每个模型步骤结束再打一个「步骤结束」增量点，`stepId` 进检查点元数据，`checkpoint.created(reason=step)` 写 Journal。
- review 的撤销优先走 checkpoint：用「开始 → 结束」的 `diffPaths` 得到这一轮真实改过的路径，恢复时带 `expect = 结束` 做三方核对；工作树在结束之后又被改过的路径整轮拒绝。新建的文件在恢复时删除，`shell` / 脚本写入因此也进入撤销范围。
- 检查点优先的列表不再要求这一轮有工具账：没有 `review_turn_files` 行的 shell-only 轮从起止检查点的 `diffNumstat` 取得文件与行数；右坞 diff 从起止快照各读一份。撤销状态单独存在 `review_reverted_turns`，重启后仍知道哪一轮撤过。
- 写租约已进入提交路径：真正的 `turn` 在交给 omp 前按工作区 `acquire`，轮次收口 / 提交失败 / 线程删除时释放；另一条线程抢同一本地工作区会收成 `workspaces.write_busy`，不会并发写。
- 隔离工作区的后端已接：Workspace 记录 `mode/sourcePath/baseRef/branch`；`workspaces.createIsolated` 从本地工作区建 worktree（路径在数据目录 `worktrees/`），`workspaces.deliver` 用 worktree 相对基线的补丁 `git apply --3way` 到主仓库，`discard/remove` 回收 worktree 与分支。线程绑定隔离工作区后，运行时/检查点/审查都只看见 worktree 路径。
- 启动对账已回收 worktreesDir 里没有工作区记录的孤儿 worktree；缺失的隔离目录只统计（UI 显示 exists=false）。
- 隔离 worktree 的侧栏入口已接：项目组头菜单按模式显示「创建隔离副本 / 交付到主仓库 / 丢弃隔离副本」，目录缺失的组头带警告标记。
- 仍未做：每次变更型工具之后的细粒度（同一步多个工具）、大文件/二进制阈值与还原前提示、三方冲突的逐文件合并界面；当前交付冲突仍整次拒绝并回报原因。

# review

- **我是什么**：审查面的领域模型——变更清单、快照与提交意图，以及 porcelain v2
  记录的纯解码。
- **我拥有什么**：`ChangeStatus` / `FileChange` / `ReviewSnapshot` / `CommitIntent`
  与它们的解码判据；全部是纯函数，不碰进程与文件系统。
- **谁允许调用我**：git-adapter（它跑 git、拼快照）、组合根。
- **我不许知道**：git 命令行、怎么跑进程、怎么渲染。

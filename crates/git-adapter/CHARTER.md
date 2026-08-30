# git-adapter

- **我是什么**：git 命令行适配器：跑 git、解析输出、拼审查面快照。
- **我拥有什么**：git 子进程调用与错误语义（GitError）、分支快照与切换、
  review 的执行编排、工作树监视（watch）。
- **谁允许调用我**：组合根（src-tauri 的命令层）。
- **我不许知道**：审查面怎么渲染、哪个目录允许被操作 —— 前者归 review-ui，
  后者是命令层的事。领域类型与 porcelain 解码归 crates/review。

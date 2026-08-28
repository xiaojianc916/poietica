# tools

- 我是什么：仓库自己的开发与契约工具，跟应用一样受类型检查。
- 我拥有什么：清理与 git hook 安装（dev/）、契约快照同步（contract/）、架构约束（architecture/）。
- 谁允许调用我：根 package.json 的脚本与 CI。
- 我不许知道什么：应用运行时的任何东西；工具不得被产品代码 import。

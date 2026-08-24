# Tests

测试就近放在它所断言的东西旁边。仓库根目录的 `tests/` 只留一样东西：
**跨包的、没有任何单个包能独自持有的仓库级不变量。**

## 目录约定

- 各包内 `src/__tests__/`：该包自己的单元测试与契约测试。断言谁的行为，
  就住在谁的包里 —— 它随包一起被移动、被改名、被删除。
- `tests/unit/architecture/`：仓库级不变量。目前是依赖图闸门：
  任何包都不得 import 一个自己没有在 package.json 里声明的 `@poietica/*`。
- `tools/architecture/`：正则形态的架构规则（`rules.config.mjs` 是数据，
  `run.mjs` 是执行器）。加一条规则等于加一个对象，不等于加一个脚本。

不要在 `tests/` 下新建只服务于某一次迁移的目录或守卫文件。
`run.mjs` 会主动拒绝 `check-*.mjs` 这类一次性守卫，理由同样适用于
一次性的 `.test.ts`：它把一次迁移编码成文本快照，迁移结束后无声腐烂。

## 质量规则

- 测试名称描述长期行为或契约，不描述某一次修复或 Issue。
- 每个测试必须验证可观察结果、错误边界或不变量；禁止只验证 mock 调用而忽略结果。
- fixture 必须保留测试输入，禁止用 `void input` 丢弃参数后返回固定值。
- 失败、回滚、取消和恢复路径应与正常路径同等重要。
- 新增测试前先判断现有测试文件是否已覆盖同一长期契约；优先扩展现有测试，
  而不是创建一次性回归文件。

## 运行

```bash
bun run test                     # 全部工作区的 test 任务
bun run test:architecture        # 正则架构规则
bun run --filter @poietica/ui test
bun run --filter @poietica/tests test
```

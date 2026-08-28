# Poietica 项目长期备忘

## 工具链事实（2026-08-28 重构批次确认）
- 工作区实际生效的 tsc 是 **TypeScript 7.0.2（Go 原生编译器）**，与 `@typescript/typescript6@6.0.2` 并存；catalog: 钉版本。
- TS7 对 **never 返回函数的调用点窄化**支持不可靠（TS5/6 下 `if (x === undefined) die(...)` 能收窄 x，TS7 报 TS18048）。稳态写法：`return die(...)` 早返回，只依赖普通 return 控制流。
- tsconfig.base.json 开着 `noPropertyAccessFromIndexSignature`：索引签名（含 `process.env`）必须方括号访问，如 `process.env['KIMI_CODE_HOME']`——这是全仓惯例，不是可选项。

## biome 约定
- tools 目录的 CLI 脚本（.mjs 与 .ts）noConsole 豁免在 biome.json overrides；库/UI 代码不允许 console（warn/error 除外）。
- `bun run check:web` = biome ci 全仓 + tools/architecture + turbo typecheck/test，是 TS 侧验收门。

## refactor.mjs 生成约定（2026-08-29 修订）
- 生成物里的转义全靠 bake()：`@@`→反勾号、`@$`→美元符、`@{`→`${`。第三条是踩坑换来的：
  `String.raw` 拦不住外层模板对 `${...}` 的求值，只写 `@${x}` 会让生成脚本在顶层就崩。
- patch() 先判「新形态已在场」再判「锚点命中」；否则新形态含旧锚点的补丁（插入块末尾原样
  带回常量那一行）会在第二次跑时重复插入一整块。

## 重构批次进行中
- 批次 1-2：refactor.mjs 是幂等生成脚本（已存在的文件跳过）；改生成物必须同步改脚本内的副本，否则留下错误源头。
- 批次 2（2026-08-29 跑通）：发布工具链 .mjs → tools/release/*.ts，scripts/ 整棵删除；
  package.json 的 check:versions / release / verify:channel / version:set 改指向。
- crates/problem、crates/time、crates/conversation、crates/ledger 为本批新增 Rust crate；tools/ 脚本从 .mjs 迁 .ts（tools/kap/spec-sync.mjs → tools/contract/kap-spec-sync.ts，新增 tools/dev/{clean,install-git-hooks}.ts）。

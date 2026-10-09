# Poietica 工作守则（给 AI 与人类贡献者）

## 这是什么
Windows 桌面应用。三个进程：UI（React，Electron 渲染进程）↔ Host（Electron 主进程）↔ Core（`poietica-core.exe`，Bun 编译，内嵌 Oh My Pi 引擎）。
架构文档：`docs/ARCHITECTURE.md`。重构进度与偏差：`docs/refactor-log.md`。

## 目录
- `packages/`：20 个平台包，按 L0–L5 分层，只能依赖更低层（`tooling/depcruise/layers.json`）。
- `features/<id>/src/{contract,core,core-api,host,ui,ui-api}`：15 个功能包，每个功能一个垂直切片。
- `apps/core`、`apps/desktop`：组装层，只做清单与入口。
- `scripts/`：一次性维护脚本（例如 `pin-python.ts` 钉住内置 Python 的校验和）。
- `tooling/`：工具链（tsconfig 预设、depcruise 规则、refs 同步、脚手架、发布脚本）。

## 铁律
1. `bun run check` 不绿不提交。
2. 只有 `packages/engine-omp` 可以 import `@oh-my-pi/*`。
3. 功能之间只能经 `contract`、`core-api`、`ui-api` 协作；绝不 import 别的功能的 `core`/`host`/`ui`。
4. 新方法先写进功能的 `contract`（zod），再在 `core` 或 `host` 实现；内核启动时会检查遗漏。
5. 所有错误用 `AppError` + 本功能 `defineErrors` 的错误码。
6. 数据路径只来自 `DataLayout`；SQL 只写在功能的 `core/repository.ts`，表名以功能 id（`-` 换 `_`）为前缀。
7. 日志只用 `ctx.logger`，产品代码禁止 `console.*`。
8. 界面文案与视觉以基准截图为准（`docs/baseline/`，由维护者提供），不得擅自改动。
9. 第三方版本只写在根 `package.json` 的 catalog；子包写 `catalog:`。
10. 创建包或功能只能用 `bun run new:package` / `bun run new:feature`；tsconfig 的 references 只能由 `bun run refs` 生成。
11. 遇到架构文档没有覆盖的情况：写进 `docs/refactor-log.md` 的“待决问题”，停下这一项，不要猜。

## 怎么新增一个功能（九步）

`bun run new:feature <id> --parts contract,core,ui` → 写 `contract`（zod 实体/方法/通知/错误码）→
在 `packages/protocol/src/index.ts` 登记并提升 `PROTOCOL_VERSION` → 实现 `core`/`host`
（`repository.ts` 是唯一写 SQL 的地方）→ 实现 `ui` → 三个清单各加一行
（`apps/core/src/modules.ts`、`apps/desktop/src/main/modules.ts`、`apps/desktop/src/renderer/features.ts`）
→ 写测试 → `bun run refs` + `bun run protocol:snapshot` + `bun run check` → 记录偏差。
细节与判据见 `docs/ARCHITECTURE.md` §9。

## 怎么升级 omp

omp（四个 `@oh-my-pi/*` 包）锁在根 catalog 的 `18.5.0`。升级时必须**逐项核对**
16 页 §5 的陷阱表（会话文件格式、设置键、工具名与事件形状、浏览器 relay 协议……），
并把核对结果写进 `docs/refactor-log.md`；核对完成前不允许合并升级。跑
`bun run core:build` + `bun run core:probe` + `bun run check` 之后再提交。

## 禁止事项

- 禁止 `any`、`@ts-ignore`、`@ts-expect-error`、`biome-ignore`（规则例外只能写进 `biome.json` 的
  `overrides`，按精确文件路径列出，并在文件头注释说明原因）。仓库有闸门检查这些（`tooling/checks/`）。
- 禁止手写 `\\` 或 `/` 拼路径 —— 一律用 `node:path`。
- 禁止在功能里重复实现操作系统能力（读写文件对话框、开链接、发通知等一律走 platform 的契约）。
- 禁止把 `Project Refactoring Plan/`（外部输入的设计方案）提交进仓库；它已在 `.gitignore` 里。

## 常用命令
- `bun run dev`：开发运行
- `bun run check`：类型检查 + lint + 依赖规则 + 测试
- `bun run core:build` / `bun run core:probe`：构建 Core 并自检
- `bun run core:verify-dist`：校验 Core 产物哈希与 manifest，且不是探针版
- `bun run version:set <x.y.z>`：同时改 `apps/desktop` 与 `apps/core` 的版本号
- `bun run desktop:smoke <安装包>`：安装包冒烟（装、起、隔离、退出、卸载保留数据）
- `bun run dist`：打包安装程序

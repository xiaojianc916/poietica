# Poietica

**本地 AI agent 桌面应用（Windows）**，内置 [Oh My Pi](https://github.com/can1357/oh-my-pi)（omp）引擎，
开箱即用。omp 随包发布（版本锁在根 `package.json` 的 catalog）、数据只落在应用自己的数据根，与用户机器上的全局 omp 完全隔离。

[![CI](https://github.com/xiaojianc916/poietica/actions/workflows/ci.yml/badge.svg)](https://github.com/xiaojianc916/poietica/actions/workflows/ci.yml)
[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

---

## 特性

- **对话主线**：线程列表、时间线、输入框（模型 / 思考档位 / 批准方式）、插话与排队、
  计划与目标模式、审批与提问、分支、导出、归档。
- **本地能力**：内置终端、内置浏览器（agent 可经 relay 操控）、内置 Python 运行时（按需安装）、
  自动更新、定时任务。
- **扩展**：技能 / 插件 / MCP、审查（git）面板、用量统计。
- **隔离**：omp 随包发布，它与内置 Python 的数据都只落在 `%APPDATA%\Poietica\`，
  不读全局 `~/.omp`，不碰其它工具的凭据变量。

## 安装

从 [Releases](https://github.com/xiaojianc916/poietica/releases) 下载
`Poietica_<版本>_x64-setup.exe` 并运行。

## 架构速览

三个进程、三个微内核：**UI**（Electron 渲染进程，React）↔ **Host**（Electron 主进程）↔
**Core**（`poietica-core.exe`，Bun 编译）。UI↔Host 走 IPC `poietica:rpc`，Host↔Core 走 stdio
（`\x1e` 分帧），两段都是 JSON-RPC 2.0；Host 只看信封做路由，Core 的载荷以文本原样转交给页面解析。

```
┌────────── UI 进程 ──────────┐ ┌────────── Host 进程 ─────────┐ ┌────────── Core 进程 ─────────┐
│ ui-kernel（贡献点、服务）    │ │ host-kernel（模块、RpcHub）  │ │ core-kernel（模块、迁移）    │
│ workbench（外壳，只渲染贡献）│◄┤ CoreSupervisor（看护 Core）  ├►│ engine 端口 ◄─ engine-omp    │
│ design-system                │ │ Electron                     │ │ omp SDK（随包、隔离）        │
└──────────────────────────────┘ └──────────────────────────────┘ └──────────────────────────────┘
       IPC 'poietica:rpc'（JSON-RPC 2.0）        stdio（\x1e 帧，JSON-RPC 2.0）
```

五条结构性承诺：

1. **一个功能只在一个地方**：增删功能 = 增删 `features/<x>/` 一个目录，再改应用清单各一行。
2. **外壳不认识功能**：`workbench` 与三个内核只渲染与调度「贡献」，不出现具体功能的名字。
3. **业务不认识 omp**：只有 `packages/engine-omp` 能 import `@oh-my-pi/*`，业务只认 `@poietica/engine` 端口。
4. **运行时由类型系统把关**：每个包、每个子入口按运行时继承 tsconfig 预设，写错进程的 import 直接类型检查失败。
5. **每份事实只存一处**：对话正文只在 omp 会话文件里，其余数据各有唯一主人。

分层（只能依赖更低层，同层互不依赖）：

```
L5  汇总与外壳   protocol · workbench · apps/core · apps/desktop
L4  功能         features/*（16 个垂直功能包）
L3  内核与适配   core-kernel · host-kernel · ui-kernel · design-system · engine-omp · engine-testkit
L2  运行时工具   runtime-layout · process-kit · fs-kit · logging · storage-sqlite · git · test-kit
L1  契约与模型   contract-kit · rpc · transcript · engine
L0  基础         foundation
```

## 目录结构

```
apps/core              Core 的装配与构建脚本（三个内核清单之一）
apps/desktop           Electron 的装配：主进程与渲染进程
features/<id>          垂直功能切片：contract / core-api / core / host / ui-api / ui
packages/*             20 个平台包（内核、引擎端口、契约工具、设计系统……）
tooling/               tsconfig 预设、depcruise 规则、脚手架、发布脚本、自定义闸门
docs/                  架构、omp SDK 参考、重构日志、发布说明
```

每个功能包在 `src/` 下按子入口拆分，子入口用 `package.json` 的 `exports` 暴露；
三个应用清单（`apps/core/src/modules.ts`、`apps/desktop/src/main/modules.ts`、
`apps/desktop/src/renderer/features.ts`）是唯一的装配点。

## 开发

需要 **Bun 1.4.3+**（`packageManager` 锁定，`bun check` 做类型检查）与 **Node 20+**（Electron 与部分工具链用）。
CI 跑在 `windows-latest`。

```bash
bun install
bun run dev          # 构建 Core 后启动 electron-vite 开发模式
```

| 命令 | 作用 |
| --- | --- |
| `bun run  all` | **唯一的准入闸门**：typecheck + lint（biome、自定义闸门、depcruise）+ test |
| `bun test <路径>` | 只跑某一部分测试 |
| `bun run format` | biome 自动格式化 |
| `bun run refs` | 按 package.json 依赖同步 tsconfig references（禁止手改 references） |
| `bun run protocol:snapshot` | 契约形状变化后更新协议快照 |
| `bun run core:build` / `core:probe` / `core:verify-dist` | 构建 `poietica-core.exe`、进程级隔离自检、校验产物 |
| `bun run desktop:build` | 只构建 Electron 三端产物（不出安装包） |
| `bun run dist` | 构建并打安装包（产物在 `apps/desktop/release/`） |
| `bun run desktop:smoke <安装包>` | 安装包冒烟测试 |
| `bun run new:package` / `new:feature` | 脚手架（创建包或功能的唯一入口） |
| `bun run version:set <x.y.z>` | 版本号的唯一入口（同时改根、desktop 与 core） |
| `bun run python:pin` | 升级内置 Python 时钉住校验和 |

改契约、加功能、升级 omp 的完整步骤见 `docs/ARCHITECTURE.md` §9 与 `AGENTS.md` §11。

## 文档

| 文档 | 用途 |
| --- | --- |
| `docs/ARCHITECTURE.md` | 现状架构：分层、进程、契约、数据归属、测试策略、扩展配方 |
| `AGENTS.md` | 工作守则与边界铁律（AI 与人类贡献者都先读这一页） |
| `docs/omp-sdk-reference.md` | 随包 omp 的精确 API（带源码行号），写 engine-omp 前先查这里 |
| `docs/refactor-log.md` | 重构进度、偏差、待决问题 |
| `docs/release-notes/` | 每个版本的发布说明 |

## 贡献

- 提交信息用 `<type>(<scope>): <中文说明>`（type 取 `feat` / `fix` / `refactor` / `test` / `docs` / `chore`）。
- 改动只覆盖任务点名的范围；架构上拿不准的记进 `docs/refactor-log.md` 的「待决问题」，不要猜。
- `bun run  all` 不绿不提交。

## 许可

[AGPL-3.0-or-later](LICENSE)

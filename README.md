# Poietica

本地 AI agent 桌面应用（Windows）。内置 Oh My Pi 引擎，开箱即用，与全局 omp 完全隔离。

## 安装

下载 `Poietica_<版本>_x64-setup.exe` 并运行。安装包**没有代码签名**，Windows SmartScreen 会提示
「未知发布者」—— 点「更多信息」→「仍要运行」即可。

> **0.5.0 起的历史对话与设置不从 0.4.x 迁移**：新版本用新的数据布局
> （`%APPDATA%\Poietica\`），装完请重新填一次 API key。卸载会保留数据根。

## 开发

需要 [Bun](https://bun.sh) 1.4.3+ 与 Node 20+（Electron 与部分工具链用）。

```bash
bun install
bun run dev          # 构建 Core 并启动 electron-vite 开发模式
```

| 命令 | 作用 |
| --- | --- |
| `bun run  all` | 类型检查 + lint（含依赖规则）+ 全部测试 —— 唯一的准入闸门 |
| `bun run core:build` / `core:probe` | 构建 `poietica-core.exe` 并做隔离自检 |
| `bun run core:verify-dist` | 校验 Core 产物与 manifest 一致，且不是探针版 |
| `bun run desktop:build` | 只构建 Electron 三端产物（不出安装包） |
| `bun run dist` | 构建并打安装包（产物在 `apps/desktop/release/`） |
| `bun run version:set <x.y.z>` | 版本号的唯一入口（同时改 desktop 与 core） |
| `bun run desktop:smoke <安装包>` | 安装包冒烟测试 |
| `bun run refs` | 按 package.json 依赖同步 tsconfig references |
| `bun run protocol:snapshot` | 重新生成契约快照（契约改了必须跑） |
| `bun run python:pin` | 升级内置 Python 时钉住新的校验和 |

## 文档

- 架构（现状）：`docs/ARCHITECTURE.md`
- 工作守则与铁律：`AGENTS.md`
- 重构过程、偏差与待决问题：`docs/refactor-log.md`

## 许可

AGPL-3.0-or-later，见 `LICENSE`。

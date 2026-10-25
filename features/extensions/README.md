# @poietica/feature-extensions

技能（SKILL.md）、MCP 服务器与插件三类扩展的产品侧管理；安装、启停与状态经引擎端口落到 omp。

## 职责

- `skills.*` 列出全局或指定工作区的技能，启停、安装（目录或 zip）与删除用户技能；删除移入回收站，内置与项目技能不可删除。
- `mcp.*` 列出、写入、删除服务器，读取连接状态，并在 Smithery 目录中搜索；`mcp.upsert` 按名字幂等写入。
- `plugins.*` 列出已安装插件、查询 omp 市场、安装、卸载与启停；卸载与启停时把引擎的 not found 翻译为本契约错误码。
- UI 提供「技能」「MCP」两页；技能页可查看 SKILL.md（右坞面板），安装入口在命令面板。加号面板经 `composerToolkitSources` 取得技能与 MCP 名册。

## 子入口

| 入口       | 内容                                                                     |
| ---------- | ------------------------------------------------------------------------ |
| `contract` | 三个命名空间的 15 个方法与 3 条通知；`SkillInstallSource` 等实体         |
| `core`     | 调引擎端口，发 `skills.changed`、`mcp.statusChanged`、`plugins.changed`  |
| `ui`       | 技能页、MCP 设置页、技能文档右坞面板、名册来源、`/mcp` 与 `/skills` 命令 |

## 对外接口

方法按 `skills`、`mcp`、`plugins` 分组；`skills.install`、`mcp.catalog`、`plugins.install` 使用加长的 `timeoutMs`。

错误码：`extensions.skill_not_found`、`extensions.skill_not_removable`、`extensions.invalid_skill_package`、`extensions.plugin_not_found`、`extensions.mcp_name_conflict`；`mcp.upsert` 只有按名更新一种语义，`mcp_name_conflict` 当前不可达。

## 边界

插件契约与 API 已就位，当前 UI 只落了技能与 MCP 两页；技能安装入口在命令面板的 `extensions.installSkillFromFolder` / `extensions.installSkillFromZip`。

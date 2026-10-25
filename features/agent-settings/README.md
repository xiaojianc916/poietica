# @poietica/feature-agent-settings

把 agent 自己的设置目录接到桌面设置界面：按引擎报出的 descriptor 渲染「记忆」「个性化」，并提供电脑操控与浏览器控制两个能力开关。

## 职责

- Core 读取 `engine.settings` 的设置目录，按 `group` 键归并成 `SettingGroup`；组序沿用引擎的 `groupOrder`，表外组按首次出现排在后面，标题取 `groupLabel`。
- 写入前按 descriptor 的 `type` 校验：`boolean`、有限 `number`、`enum` 的 `option.value`、`string`；引擎端口会再校验一次。
- 目录、值与能力开关的事实都在引擎和 `SettingsPort`；本功能不建表，也没有逐项设置的表单代码。
- UI 注册记忆、个性化与电脑控制三页。前两页读同一份 `agentSettings.catalog`，只画 `section` 匹配且未被别处接管的项；条件不成立或条件名无法识别的项不显示。电脑控制页只读写两个能力开关。

## 子入口

| 入口       | 内容                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------- |
| `contract` | `agentSettings.*` 的方法、通知与错误码；`SettingDescriptor`、`SettingGroup`、`Capabilities` |
| `core`     | 目录归并、类型校验、写入与恢复默认、能力开关                                                |
| `ui`       | 三个设置页与设置控件；`/memory`、`/computer` 斜杠命令只负责跳转                             |

## 对外接口

`agentSettings.catalog`、`agentSettings.set`、`agentSettings.reset`、`agentSettings.capabilities`、`agentSettings.setCapability`；变化经 `agentSettings.changed` 发出，载荷是路径列表。

错误码：`agent-settings.unknown_setting`、`agent-settings.invalid_value`。

## 边界

本功能只暴露引擎已开放的设置项，不定义语义也不持久化值；`/computer` 仅打开电脑控制页。

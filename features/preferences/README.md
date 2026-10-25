# @poietica/feature-preferences

偏好与界面记忆：持久化应用设置、主题、快捷键覆盖和按窗口恢复的界面状态。

## 职责

- **偏好**：`preferences.json` 保存 `theme`、`language`、`logLevel`、`general`、`appearance`、`modelPicker`、`updates`；`prefs.update` 做分组字段级合并、校验、落盘、广播，再执行副作用。
- **主题**：`theme.set` 与 `prefs.update({ theme })` 等价。Host 在窗口创建前设定 `nativeTheme.themeSource`，窗口底色按解析后的深浅色配置，避免深色启动白闪；系统深浅色变化时广播 `theme.changed`。
- **日志级别**：Host 更新自身日志级别，并在 Core ready 及每次重新 ready 时经 `diagnostics.setLogLevel` 同步给 Core。
- **界面记忆**：`ui-state.json` 按封闭的 `UiStateKey` 枚举保存布局、路由、草稿、批准方式、吉祥物选项等；`uiState.set` 去抖 500ms 落盘，退出时 flush。`keymap.json` 独立保存命令到按键的覆盖表。
- **恢复规则**：`UI_STATE_RESTORE` 为每个键声明 `setup`、`onDemand` 或 `reserved` 阶段；`ui-api` 的 `uiStateSlot` 在 setup 中先读后恢复，恢复前不写回，读失败可按 `release` 或 `hold` 处置，并支持 `retry`。
- **设置页**：贡献「通用」「外观」「快捷键」三页；通用页的「恢复默认」写回一份初始偏好 patch，快捷键页可逐命令录制或恢复默认。

## 子入口

| 入口       | 内容                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `contract` | `prefs.*`、`uiState.*`、`theme.*`、`keymap.*`；`Preferences`、`PreferencesPatch`、`UiStateKey`、`UI_STATE_RESTORE`、`KeyOverrides` |
| `host`     | 三个 JSON 文档的读写、主题副作用、日志级别同步、三个通知的广播                                                                     |
| `ui`       | 启动时主题投影、布局与路由恢复、设置页、偏好变更订阅                                                                               |
| `ui-api`   | `PreferencesToken`：`current`、`subscribe`、`update`、`uiStateSlot`                                                                |

## 对外接口

契约方法均为 `owner='host'`：`prefs.get` / `prefs.update`、`uiState.get` / `uiState.set`、`theme.set`、`keymap.get` / `keymap.set` / `keymap.reset`。通知为 `prefs.changed`、`theme.changed`、`keymap.changed`。

`PreferencesToken` 供其它功能读偏好、订阅变化、写 patch，并开 `uiStateSlot`；写偏好一律走契约。`keymap.set` 的 `null` 表示禁用该命令。错误码为 `preferences.write_failed` 与 `preferences.keymap_unknown_command`。

## 边界

偏好与界面记忆都住在 Host 的 JSON 中，不依赖 Core 就绪，因此布局、路由与草稿能在首帧前恢复。本功能不拥有业务状态：对话草稿、权限姿态等由各自功能定义形状，只借用 `uiStateSlot` 完成恢复与写回。功能分级与设置贡献规则见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §4.3。

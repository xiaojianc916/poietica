# omp TUI 库（pi-tui）

> 来源：`TUI/src`（18.3.0）。pi-tui 是独立包："Terminal User Interface library with differential rendering for efficient text-based applications"；omp 的交互界面、Agent Hub、工具卡片全部构建其上。

## 1. 渲染管线

- 差分渲染（differential rendering）无闪烁更新；无原生依赖（跨终端）。
- 终端能力探测（terminal-capabilities.ts）、kitty-graphics（图形协议）、SIXEL（经 pi-natives encodeSixel/decodeSixelToPng）、glyph-protocol（私有字形协议）、deccara、bracketed-paste（大粘贴菜单 `paste.largeMenuThreshold`）、mouse 支持（mouse.ts；`tui.mouse`）、tmux 集成（tmux.ts）、windows-altgr 修复（Windows AltGr）、stdin-buffer、ttyid、loop-watchdog、debug-server、desktop-notify。
- 文本度量原语来自 pi-natives：`truncateToWidth/visibleWidth/wrapTextWithAnsi`。

## 2. 组件（src/components/）

editor（多行输入编辑器）、composer（chat 输入区；shape 可换：`composer.shape` "band" 等 + overlays/composer-shape-registry，扩展可 registerComposerShape）、box、cancellable-loader、disclosure、form、image（内联图片；`tui.maxInlineImageColumns 50 / Rows 20 / maxInlineImages 8`）、input、key-value-list、loader、markdown（mermaid-ascii 渲染 `tui.renderMermaid`；LaTeX→Unicode：latex-block/latex-to-unicode；math-delimiters）、menu-selection、metric、progress-bar、scroll-view、scroll-viewport、section、select-list、settings-list、spacer、tab-bar、table、text、tree-view、truncated-text、wizard-step、layout/。

## 3. Overlays（60+，src/overlays/）

agent-hub（+ agent-hub-projection/renderer/types/activity/agent-transcript-viewer）、advisor-config、annotation-overlay（/annotate 全屏）+ annotation-types、ask-dialog、bordered-loader、btw-history(-panel)/btw-panel、cleanse-panel、codex-reset-fireworks（彩蛋烟花；`tui.codexResetFireworks`）、composer-shape-preview、copy-selector/copy-targets、error-banner、extensions/、history-search、hook-editor/hook-input/hook-selector（SDK 导出别名 Extension*Component）、hub-frame、login-dialog、logout-account-selector、mcp-add-wizard、model-browser/model-hub/model-picker/model-selector、move-overlay、oauth-selector、omfg-panel、pause-screen、plan-review-overlay/plan-save-overlay/plan-toc、plugin-selector/plugin-settings、queue-mode-selector、reset-usage-selector、rewind-selector、running-subagent-badge、session-account-selector、session-info-overlay/session-selector/session-observer-registry、settings-defs/settings-selector、show-images-selector、snapcompact-shape-preview(+doc)、theme-selector、thinking-selector、tiny-title-download-progress、tree-selector、usage-dashboard/usage-display/usage-row。

## 4. Chat 消息组件（src/chat/）

assistant-message（含 thinking-display、reactions `tui.reactions`）、advisor-message、background-tan-message、bash-execution、cache-invalidation-marker、chat-transcript-builder、collab-prompt-message、compaction-summary-message、custom-message、display-preferences、eval-execution、execution-shared、extension-types（ExtensionUiComponent 等导出）、hook-message、image-loading、late-diagnostics-message、messages、read-target、read-tool-group、served-model-marker、skill-message、skill-title-input、stripped-tool-calls-placeholder、todo-reminder、tool-execution（工具卡片体系）、transcript-browser/transcript-entry/transcript-outline。

## 5. 输入编辑器

- editor-component + prompt/custom-editor（CustomEditor）；autocomplete（CombinedAutocompleteProvider：@文件引用、/命令、skill tokens `SKILL_TOKEN_RE`）；kill-ring；**vim mode**（vim.ts；`tui.vimMode/vimModeDisplay`）；latex-block；hotkeys-markdown；emoji 自动补全（`emojiAutocomplete`）；拼写（`spelling.typoDetection/autocomplete/autocorrect`）；IME 安全光标（`tui.imeSafeCursor`）；fuzzy（fuzzy.ts）；keys.ts/keybinding-matchers/keybindings.ts。
- 键位体系：keybindings.ts 声明式 action 表（defaultKeys 多绑定，示例：cursor-left=[left, ctrl+b]、kill-word=[ctrl+w, alt+backspace, ctrl+backspace, super+alt+backspace]）+ app-keybindings（AppKeybinding 全局键：Agent Hub Alt+A、display-reset alt+l 等）；可自定义（keybindings 配置）；官方键位文档页 /docs/keybindings（Ctrl+O 展开卡片、Escape 停止 turn 等）。

## 6. 主题（src/theme/）

- 内置 **100 个主题 JSON**（theme/defaults/）：
  - dark 系（49）：titanium（默认 dark）、obsidian、onyx、graphite、anthracite、basalt、dark-abyss/arctic/aurora/catppuccin/cavern/celestial/copper/cosmos/cyberpunk/dracula/eclipse/ember/equinox/forest/github/gruvbox/lavender/lunar/midnight/monochrome/monokai/nebula/nord/ocean/one/poimandres/rainforest/reef/retro/rose-pine/sakura/slate/solarized/solstice/starfall/sunset/swamp/synthwave/taiga/terminal/tokyo-night/tundra/twilight/volcanic；
  - light 系（~45）：light-arctic/aurora-day/canyon/catppuccin/cirrus/coral/cyberpunk/dawn/dunes/eucalyptus/forest/frost/github/glacier/gruvbox/haze/honeycomb/lagoon/lavender/meadow/mint/monochrome/ocean/one/opal/orchard/paper/poimandres/prism/retro/sand/savanna/solarized/soleil/sunset/synthwave/tokyo-night/wetland/zenith（默认 light）；
  - 石材系：alabaster、amethyst、birch、limestone、mahogany、marble、pearl、porcelain、quartz、sandstone。
- schema.ts + schema-validation + loader（自定义主题目录 `~/.omp/agent/themes/`，TUI watcher 热加载）；color.ts；glyph-bundle.json；mermaid-cache。
- `theme.dark/theme.light` 随终端外观切换（MacAppearanceObserver / detectMacOSAppearance）；`symbolPreset`（unicode/nerd/ascii）+ symbols.ts；`colorBlindMode`。

## 7. Status line（src/status-line/）

component、context-usage（context gauge + speculation marker + cacheMissMarker）、footer、git-utils、host、index、loop、metrics（tokens/sec）、presets（default/minimal/compact/full/nerd/ascii/custom）、schema。omp 侧宿主：`modes/status-line-host.ts`（见 cli-and-modes.md §8）。

## 8. Apps（全屏应用，src/apps/）

session-picker、setup-model-picker、standalone-picker、git（全屏 git UI）、ps-top/ps-data、debug/、live-visualizer、autoresearch-dashboard/autoresearch-data、cleanse-board/cleanse-picker、if-bench-board。

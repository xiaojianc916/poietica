# 0001. Opaque window surface for resize stability

- Status: Accepted
- Date: 2026-07-22
- Owners: Desktop application composition root

## Context

Poietica 使用 Tauri 2 承载 React 和 WebView2。

主窗口原先同时配置了：

```json
{
  "decorations": false,
  "transparent": true
}
```

产品使用自绘标题栏，但并不需要让桌面内容穿透主编辑窗口。无边框窗口和透明窗口是两个不同的能力；自绘标题栏只要求关闭系统 decorations，不要求开启透明合成。

在 Windows live move/live resize 期间，以下表面可能在不同时间完成提交：

1. 操作系统原生窗口；
2. WebView2 controller surface；
3. HTML document；
4. React 渲染内容。

当原生窗口本身透明时，WebView 尚未提交新尺寸帧的区域会直接露出桌面或后方窗口。CSS 与 React 无法绘制尚未由 WebView 提交的原生区域，因此在前端增加 resize 监听或强制重绘不能解决该边界问题。

## Decision

主编辑窗口采用不透明 backing surface。

唯一允许的 backing surface 颜色为：

```text
#f3f3f3
```

该颜色必须同时存在于三个层级：

1. **Tauri WindowConfig**
   - `transparent: false`
   - `backgroundColor: "#f3f3f3"`
   - 负责原生窗口与 WebView 默认表面。

2. **HTML bootstrap surface**
   - 在应用模块脚本执行前声明。
   - 负责 CSS bundle 与 React 初始化前的首帧。

3. **Application root surface**
   - `html`、`body`、`#root` 使用
     `--window-backing-surface`。
   - 负责应用运行期的根表面。

仓库通过 `tools/architecture/rules.config.mjs` 的 `window-surface-policy`
验证三个层级与 WebView2 合成策略没有发生漂移。

## Explicitly rejected approaches

以下方案不得作为该问题的修复：

- 在 `resize` 事件中调用 React 强制更新；
- 在拖动期间反复修改 DOM 尺寸；
- 使用 `requestAnimationFrame` 运行持续重绘循环；
- 通过读取 `offsetWidth` 强制同步 layout；
- 使用任意 Win32 hook 绕过 Tauri/WebView2；
- 通过扩大 IPC 权限让前端直接操作原生窗口句柄；
- 使用透明窗口后再用额外 DOM 层模拟不透明背景。

这些方案位于错误的所有权边界，会增加主线程工作、破坏 Editor 生命周期，或制造平台特有技术债。

## Consequences

### Positive

- 窗口拖动和缩放期间，未及时提交的区域显示稳定的
  `#f3f3f3`，而不是桌面内容。
- 应用启动、CSS 加载和 React 初始化阶段使用同一底色。
- 不向 React 状态引入窗口生命周期逻辑。
- 架构检查可阻止后续提交重新开启主窗口透明。

### Limitations

该决策消除的是透明合成导致的桌面露出，并提供确定的 backing surface。

它不承诺消除所有 GPU、显卡驱动或 WebView2 内容重绘延迟。即使复杂界面内容暂时没有跟上窗口尺寸，用户看到的也应是规定的 backing surface，而不是后方窗口。

## Extension rule

未来若确实需要透明窗口效果，必须：

1. 使用独立窗口，而不是主编辑窗口；
2. 提交新的 ADR；
3. 明确平台兼容矩阵；
4. 提供性能基准和降级路径；
5. 不改变主窗口的不透明表面契约。

## Official references

- Tauri 2 WindowConfig:
  https://v2.tauri.app/reference/config/
- Tauri window customization:
  https://v2.tauri.app/learn/window-customization/
- Microsoft WebView2 rendering APIs:
  https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/overview-features-apis

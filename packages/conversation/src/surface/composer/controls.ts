/*
 * 两个 composer（对话与自动化）共用的框体、量度与会话配置控件。
 *
 * 框体与量度是纯样式，经 './frame.css' 与 './actions.css' 按需引入；
 * 控件是纯渲染：SessionConfigControl 进，回调出，状态仍归调用方。
 */

export { PermissionPicker } from './permission-picker'
export {
  isToggleControl,
  labelOf,
  SessionControls,
  sessionControlRows,
} from './session-controls'

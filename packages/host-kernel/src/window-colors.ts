/**
 * 窗口底色：拖拽或还原窗口的那一瞬间露出的那一层。
 *
 * 深色 #202020 是 design-system 调色板里深色窗口衬底的正本
 * （packages/design-system/src/tokens/palette.css 的 --ui-palette-dark-850）。
 * renderer 的 --window-backing-surface（apps/desktop/src/renderer/styles.css）
 * 持同一份投影，改这一格必须两处同改。
 *
 * platform 与 preferences 原先各存一份逐字相同的副本（头注还写着「两处同改」，
 * 实际早已是三处），收到这里一份。
 */
export const WINDOW_BACKGROUND = Object.freeze({ light: '#ffffff', dark: '#202020' })

/*
 * 提供者与读法都在 ui-api（见 composer-assets.ts 的头注）。
 * 这一层转发让 legacy 迁入的组件 import 路径保持原样。
 */
export { AttachmentIntakeContext, useAttachmentIntake } from '../../../ui-api/composer-assets'

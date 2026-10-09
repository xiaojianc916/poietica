/*
 * 资产形状与入库口已移到 ui-api（attachments 功能也要用同一份）。
 * 这里留一层转发：legacy 迁入的组件 import 路径一字未改。
 */
export type {
  AttachmentIntake,
  AttachmentUpload,
  ComposerAsset,
  ComposerAssetContext,
} from '../../ui-api/composer-assets'
export { isInlineAttachment } from '../../ui-api/composer-assets'

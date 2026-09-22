import { type AssetUploadResult, commands } from '@poietica/contract'
import { throughIpc } from '../ipc-error'

/*
 * 资产会话：一批附件挂在一个令牌下面，关掉就一起释放。
 *
 * 原生命令统一经 ipc-error.ts 的 throughIpc 调用。AssetUploadResult 直接取自
 * 生成绑定，Rust 侧的类型是权威。
 *
 * 路径导入不传字节：拖放与文件对话框交给渲染层的是路径，读盘发生在原生侧，
 * 避免 webview 先读入、编码再送回本机进程；剪贴板上传仍传 base64。
 */

/**
 * 原生按路径入库之后交回来的那一份。
 *
 * kind 为 Image 时 source 是 <img src> 能直接用的资产协议地址；kind 为 File
 * 时是通用文件（含文本、压缩包等），字节已暂存在原生侧、source 为空，界面渲染
 * 文件卡片而不是预览。
 */
export type AssetImport = AssetUploadResult

/** 开一条资产会话，拿到它的令牌。 */
export function openAssetSession(): Promise<string> {
  return throughIpc(async () => {
    const opened = await commands.assetSessionOpen()

    return opened.sessionToken
  })
}

/**
 * 把这些路径读进会话，顺序与传入一致。
 *
 * 选择框收所有文件：图片按文件头进内存注册表走预览，其余一律按通用文件暂存，
 * 不再整批拒绝未知格式。
 */
export function importAssets(
  sessionToken: string,
  paths: readonly string[],
): Promise<readonly AssetImport[]> {
  /* readonly 的数组与生成绑定要的可变数组是两个类型，所以复制一次 ——
  数组复制只在这一层做。 */
  return throughIpc(() => commands.assetImport({ sessionToken, paths: [...paths] }))
}

/**
 * 剪贴板里的那一张图（只可能是图片）。
 *
 * 三条进门的路里只有这一条要经过字节：截图是一团没有名字也没有路径的 blob，
 * 系统给不出路径，所以它走不了 importAssets。拖放与文件对话框交的都是路径。
 *
 * 内容类型不在参数里。它由原生按文件头判定，与 importAssets 共用同一个判据 ——
 * 渲染层报的 `File.type` 来自扩展名，而资产协议是带 nosniff 投递的。
 */
export function uploadAsset(sessionToken: string, base64: string): Promise<AssetImport> {
  return throughIpc(() => commands.assetUpload({ sessionToken, base64 }))
}

/**
 * 从会话里放掉一个附件。图片释放注册表预算；通用文件本就不在注册表里，
 * 原生侧查无此项时按成功处理（暂存字节随 tmp 对账清空）。
 */
export function removeAsset(sessionToken: string, assetToken: string): Promise<void> {
  return throughIpc(async () => {
    await commands.assetRemove({ sessionToken, assetToken })
  })
}

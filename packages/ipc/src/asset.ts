import { type AssetFormat, type AssetUploadResult, commands } from '@poietica/contract'
import { throughIpc } from './error'

/*
 * 资产会话：一批图片挂在一个令牌下面，关掉就一起释放。
 *
 * 这一层只做一件事 —— 把原生那三条命令包成"一次调用只有一条路"的形状（见
 * error.ts 的 throughIpc）。形状不在这里重新定义：AssetUploadResult 直接取自
 * 生成绑定，Rust 侧的类型是权威。
 *
 * 字节不出现在这个文件里，也不出现在任何一条命令的参数里。拖放与文件对话框
 * 交给渲染层的是路径，读盘发生在原生侧：webview 不该为了把一张 4 MB 的 PNG
 * 交给本机进程，先把它读进内存、编码、再送回去。
 */

/** 原生按路径入库之后交回来的那一份。source 就是 <img src> 能直接用的地址。 */
export type AssetImport = AssetUploadResult

/** 一种收得下的格式：内容类型，加上它在系统对话框里的扩展名。 */
export type { AssetFormat }

/**
 * 原生收得下的格式清单。
 *
 * 扩展名只给系统对话框的过滤器用，不是判据 —— 判据是文件头，在原生那一侧，
 * 而且两者出自同一张表（commands/asset.rs 的 FORMATS）。这一层因此不持有
 * 任何格式知识，它只是把那张表运过来。
 */
export function listAssetFormats(): Promise<readonly AssetFormat[]> {
  return throughIpc(() => commands.assetFormats())
}

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
 * 内容类型由原生按文件头判定，不看扩展名，也不看渲染层的猜测；认不出来的格式
 * 整批拒绝，所以调用方拿到的每一项都是能投递的。
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
 * 剪贴板里的那一张图。
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

/** 从会话里放掉一张。输入框里被移除的那一张不该继续占着注册表的预算。 */
export function removeAsset(sessionToken: string, assetToken: string): Promise<void> {
  return throughIpc(async () => {
    await commands.assetRemove({ sessionToken, assetToken })
  })
}

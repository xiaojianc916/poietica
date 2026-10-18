/** 时间线图片挂在资源协议的哪个 host 下：poietica-asset://media/<sha256>?mime=<类型> */
export const MEDIA_ASSET_HOST = 'media'

/**
 * 时间线附件（`source.kind === 'blob'`）→ 界面 <img> 用的地址。字节由 conversation 的 host 模块从 omp 的
 * blob 目录直接流出；mime 只是提示，Host 只放行白名单里的图片类型，其余一律按 octet-stream 回。
 */
export function mediaAssetUrl(sha256: string, mediaType: string): string {
  return `poietica-asset://${MEDIA_ASSET_HOST}/${sha256}?mime=${encodeURIComponent(mediaType)}`
}

/**
 * 一张图在时间线上的地址 = 原始字节的 sha256（小写十六进制）。与 omp 的 blob 目录是同一套内容寻址
 * （omp `session/blob-store.ts`：文件名就是原始字节的 sha256），所以 Host 只按这个名字去 blob 目录里读字节。
 *
 * 入参是 omp 的图片内容块本身（`{ data }`：base64）。传块对象而不是字符串，是为了让实现能按对象记住
 * 算过的结果：同一条会话反复翻页时，同一张图不必重新解码、重算、重查盘。
 */
export type MediaRef = (image: { readonly data: string }) => string

/** 块里的 base64 → 原始字节（omp 的图片块只放 base64，data URL 在读到这一层之前就被它自己解掉了） */
export function imageBytesOf(data: string): Buffer {
  return Buffer.from(data, 'base64')
}

export function sha256Hex(bytes: Uint8Array): string {
  return Bun.SHA256.hash(bytes, 'hex')
}

/**
 * 只算地址、不落盘（纯函数）：单测用，以及字节确定已经在 blob 目录里的路径（子代理会话）。
 * 主会话必须用 `session/media-store.ts` 的 `blobMediaRef`：它保证每个上屏的地址背后都有字节。
 */
export const hashMediaRef: MediaRef = (image) => sha256Hex(imageBytesOf(image.data))

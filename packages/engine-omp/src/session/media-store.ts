import { BlobStore } from '@oh-my-pi/pi-coding-agent/session/blob-store'
import { imageBytesOf, type MediaRef } from '../projector/media'

/**
 * 生产用的 MediaRef：算出地址的同时，**保证字节落在 omp 的 blob 目录里**。写盘交给 omp 自己的
 * `BlobStore.putSync`：已有同尺寸的文件只刷新 mtime、不重写；新文件先写临时文件再改名，Host 读不到半截。
 *
 * 为什么不能只算地址、等 omp 自己外置：omp 只在把消息写进会话文件时才外置图片，而且 base64 短于 1024 字符的
 * 图一直内联在会话文件里 —— 实时那一轮的附件条目比会话落盘早，小图则根本没有 blob。Host 只认
 * blob 目录，所以每个发上屏的地址都必须先有字节。
 *
 * 目录取 `layout.ompBlobsDir`（Host 读的也是它，路径只有 runtime-layout 一个产地）。在 Windows 上它就是 omp 的
 * `getBlobsDir()`，与 omp 自己外置的图共用同一份字节；即使某个平台上 omp 改走 XDG 目录，这里照样先把字节落进
 * `ompBlobsDir` —— 正确性只依赖本函数，不依赖 omp 把文件放在哪。
 */
export function blobMediaRef(blobsDir: string): MediaRef {
  const store = new BlobStore(blobsDir)
  const known = new WeakMap<object, { readonly data: string; readonly sha256: string }>()
  return (image) => {
    const hit = known.get(image)
    if (hit !== undefined && hit.data === image.data) return hit.sha256
    const { hash } = store.putSync(imageBytesOf(image.data))
    known.set(image, { data: image.data, sha256: hash })
    return hash
  }
}

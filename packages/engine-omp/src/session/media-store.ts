import { BlobStore } from '@oh-my-pi/pi-coding-agent/session/blob-store'
import { imageBytesOf, type MediaRef } from '../projector/media'

/**
 * 生产用的 MediaRef：算出地址的同时，**保证字节落在 omp 的 blob 目录里**（写盘交给 omp 的
 * `BlobStore.putSync`：同尺寸只刷新 mtime，新文件先写临时文件再改名）。不能只算地址等 omp 自己
 * 外置 —— omp 只在消息写进会话文件时才外置，base64 短于 1024 字符的图一直内联，实时那一轮的
 * 附件条目比落盘早、小图根本没有 blob，而 Host 只认 blob 目录，发上屏的地址必须先有字节。
 * 目录取 `layout.ompBlobsDir`（Host 读的也是它）；即使某平台 omp 改走 XDG 目录，这里照样先把
 * 字节落进 `ompBlobsDir` —— 正确性只依赖本函数，不依赖 omp 把文件放在哪。
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

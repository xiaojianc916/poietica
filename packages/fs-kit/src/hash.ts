import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** 流式计算文件的 SHA-256（小写十六进制）。大文件不会整个读进内存 */
export function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file, signal === undefined ? {} : { signal })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

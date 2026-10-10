import { type DiffFile, paint } from '@poietica/design-system/diff'
import { useEffect, useState } from 'react'

/*
 * 一处改动上色。
 *
 * 行模型里的片段带不带色，取决于着色器跑没跑：审查面板在 worker 里跑（review 的
 * derive.worker.ts），抽屉这一路没有 worker，就地跑同一份 paint() —— 同一个 shiki、
 * 同一套主题，两处画出来才是同一份颜色。各自实现一套分词即为缺陷。
 *
 * 按文件记账：toDiffFiles 交回的引用稳定（file-diff.ts 的 WeakMap），所以同一个文件
 * 只算一遍；shiki 自己也缓存词元，重开抽屉是热的。
 *
 * ponytail: 分词在主线程上跑（首次约 100ms）。真觉得卡就把它挪进 worker —— 与审查面板
 * 那条路合并，别在这里另造一套。
 */
const PAINTED = new WeakMap<DiffFile, Promise<DiffFile>>()

function paintedOnce(file: DiffFile): Promise<DiffFile> {
  const held = PAINTED.get(file)

  if (held !== undefined) {
    return held
  }

  /* 着色失败就当没上色：增删底色仍在，不该让整格塌掉。 */
  const started = paint([file]).then(
    (files) => files[0] ?? file,
    () => file,
  )

  PAINTED.set(file, started)

  return started
}

/** 交回同一处改动、正文已上色的那一份；没上完色之前先画没上色的。 */
export function usePaintedDiff(file: DiffFile): DiffFile {
  const [painted, setPainted] = useState(file)

  useEffect(() => {
    let live = true

    setPainted(file)

    void paintedOnce(file).then((next) => {
      if (live) {
        setPainted(next)
      }
    })

    return () => {
      live = false
    }
  }, [file])

  return painted
}

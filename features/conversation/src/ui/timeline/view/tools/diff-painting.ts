import { type DiffFile, paint } from '@poietica/design-system/diff'
import { useEffect, useState } from 'react'

/*
 * 行模型里的片段带不带色，取决于着色器跑没跑：审查面板在 worker 里跑，抽屉这一路就地跑同一份 paint() —— 同一个 shiki、同一套主题，两处画出来才是同一份颜色。
 * 按文件记账：toDiffFiles 交回的引用稳定，所以同一个文件只算一遍。ponytail: 分词在主线程上跑（首次约 100ms），真觉得卡就把它挪进 worker，别在这里另造一套。
 */
const PAINTED = new WeakMap<DiffFile, Promise<DiffFile>>()

/* 已经上完色的那一份：同一个文件再次挂载（卡片折叠又展开、虚拟列表回收）时同步取用，不必先画一帧没上色的。 */
const SETTLED = new WeakMap<DiffFile, DiffFile>()

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
  const settled = started.then((painted) => {
    SETTLED.set(file, painted)
    return painted
  })

  PAINTED.set(file, settled)

  return settled
}

/**
 * 交回同一处改动、正文已上色的那一份；没上完色之前先画没上色的。
 *
 * 不在 effect 里先 setPainted(file) 再等着色：那样每换一次引用（或每次重新挂载）都要先退回黑白再变彩色，
 * 流式期间就是一闪一闪。上色结果记在「它是谁的结果」名下，渲染时只认当前这份文件的。
 */
export function usePaintedDiff(file: DiffFile): DiffFile {
  const [painted, setPainted] = useState<{ readonly from: DiffFile; readonly to: DiffFile } | null>(null)

  useEffect(() => {
    if (SETTLED.has(file)) {
      return
    }

    let live = true

    void paintedOnce(file).then((to) => {
      if (live) {
        setPainted({ from: file, to })
      }
    })

    return () => {
      live = false
    }
  }, [file])

  return SETTLED.get(file) ?? (painted?.from === file ? painted.to : file)
}

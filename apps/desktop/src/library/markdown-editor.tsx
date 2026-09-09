import { Crepe, CrepeFeature } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { useEffect, useRef, useState } from 'react'

/** 交给宿主打开的协议白名单，其余原样留在正文里。 */
const FOLLOWABLE = new Set(['http:', 'https:', 'mailto:'])

function followable(href: string): string | null {
  try {
    const url = new URL(href)

    return FOLLOWABLE.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

/** 资料库没有资产管线，blob: 的寿命只到文档卸载，落进 .md 就是死链，所以内联进正文。 */
function inline(file: File): Promise<string> {
  return new Promise((settle, reject) => {
    const reader = new FileReader()

    reader.addEventListener('load', () => {
      settle(typeof reader.result === 'string' ? reader.result : '')
    })
    reader.addEventListener('error', () => {
      reject(reader.error ?? new Error('图片读取失败。'))
    })
    reader.readAsDataURL(file)
  })
}

/** 正文只在挂载时取一次：编辑期间真相在编辑器里，回灌会打断输入法与撤销栈。 */
export function MarkdownEditor({
  initial,
  onChange,
  openLink,
}: {
  initial: string
  onChange: (markdown: string) => void
  openLink: (url: string) => void
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const bridge = useRef({ onChange, openLink })
  const [seed] = useState(initial)

  bridge.current = { onChange, openLink }

  useEffect(() => {
    const root = host.current

    if (root === null) {
      return undefined
    }

    const crepe = new Crepe({
      defaultValue: seed,
      featureConfigs: {
        [CrepeFeature.BlockEdit]: {
          advancedGroup: {
            codeBlock: { label: '代码块' },
            image: { label: '图片' },
            label: '高级块',
            math: { label: '公式' },
            table: { label: '表格' },
          },
          listGroup: {
            bulletList: { label: '无序列表' },
            label: '列表',
            orderedList: { label: '有序列表' },
            taskList: { label: '待办列表' },
          },
          textGroup: {
            divider: { label: '分割线' },
            h1: { label: '标题 1' },
            h2: { label: '标题 2' },
            h3: { label: '标题 3' },
            h4: { label: '标题 4' },
            h5: { label: '标题 5' },
            h6: { label: '标题 6' },
            label: '基础块',
            quote: { label: '引用' },
            text: { label: '文本' },
          },
        },
        [CrepeFeature.CodeMirror]: {
          copyText: '复制',
          noResultText: '没有匹配的语言',
          searchPlaceholder: '搜索语言',
        },
        [CrepeFeature.ImageBlock]: { onUpload: inline },
        [CrepeFeature.LinkTooltip]: { inputPlaceholder: '粘贴链接…' },
        [CrepeFeature.Placeholder]: { mode: 'doc', text: '按 / 快速插入' },
      },
      root,
    })
    let latest = seed
    let live = false

    /** 序列化是防抖的：换文档或存盘前必须把最后一次输入交出去。 */
    const flush = () => {
      if (!live) {
        return
      }

      const markdown = crepe.getMarkdown()

      if (markdown !== latest) {
        latest = markdown
        bridge.current.onChange(markdown)
      }
    }

    const store = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        flush()
      }
    }

    const follow = (event: MouseEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !(event.target instanceof Element)) {
        return
      }

      const url = followable(event.target.closest('a')?.getAttribute('href') ?? '')

      if (url !== null) {
        event.preventDefault()
        bridge.current.openLink(url)
      }
    }

    crepe.on((listener) => {
      listener.markdownUpdated((_ctx, markdown) => {
        latest = markdown
        bridge.current.onChange(markdown)
      })
      listener.blur(flush)
    })

    root.addEventListener('keydown', store, true)
    root.addEventListener('click', follow, true)

    const ready = crepe.create().then(() => {
      latest = crepe.getMarkdown()
      live = true
    })

    return () => {
      live = false

      root.removeEventListener('keydown', store, true)
      root.removeEventListener('click', follow, true)

      void ready.then(() => crepe.destroy())
    }
  }, [seed])

  return <div className="library-editor" ref={host} />
}

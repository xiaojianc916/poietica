// SPDX-License-Identifier: AGPL-3.0-or-later
// Derived from Tolaria; modified 2026-09-08. See THIRD_PARTY_NOTICES.md.
import { memo, type ReactNode, useMemo } from 'react'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'

interface MarkdownContentProps {
  content: string
  onOpenLink: (url: string) => void
}

export const MarkdownContent = memo(function MarkdownContent({
  content,
  onOpenLink,
}: MarkdownContentProps) {
  const components = useMemo(
    () => ({
      a: ({ href, children }: { href?: string | undefined; children?: ReactNode | undefined }) => {
        let allowed = false
        try {
          allowed =
            href !== undefined && ['http:', 'https:', 'mailto:'].includes(new URL(href).protocol)
        } catch {
          allowed = false
        }
        return allowed && href ? (
          <a
            href={href}
            onClick={(event) => {
              event.preventDefault()
              onOpenLink(href)
            }}
          >
            {children}
          </a>
        ) : (
          <span>{children}</span>
        )
      },
      img: ({ alt }: { alt?: string | undefined }) => (
        <span>[图片：{alt || '附件预览尚未迁入'}]</span>
      ),
    }),
    [onOpenLink],
  )
  return (
    <div className="library-markdown">
      <Markdown
        components={components}
        rehypePlugins={[rehypeHighlight]}
        remarkPlugins={[remarkGfm]}
        skipHtml
      >
        {content}
      </Markdown>
    </div>
  )
})

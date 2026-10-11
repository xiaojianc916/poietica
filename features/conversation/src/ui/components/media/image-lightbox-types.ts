/* 灯箱的类型单独成文件：轻壳与实现都引用它，彼此之间不形成环（P-06） */

/** A previewable image, typically produced from a composer attachment. */
export type PreviewableImage = {
  /** Stable identity; falls back to `src` when omitted. */
  id?: string
  /** `asset://`, `blob:`, `data:` and `https:` sources are all supported. */
  src: string
  alt?: string
  width?: number
  height?: number
  caption?: string
}

export type ImageLightboxProps = {
  images: readonly PreviewableImage[]
  /** Index of the open slide; `null` (or `-1`) keeps the lightbox closed. */
  index: number | null
  onIndexChange: (index: number | null) => void
}

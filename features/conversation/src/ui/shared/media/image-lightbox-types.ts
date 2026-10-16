/* 轻壳与实现共用的类型单独成文件，两者之间不形成环（P-06） */

export type PreviewableImage = {
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

import { Eye, EyeOff } from 'lucide-react'
import { type ComponentProps, useState } from 'react'

/* 遮住的输入格，右侧一颗眼睛切换明文（API Key 用）。 */
type SecretInputProps = Omit<ComponentProps<'input'>, 'type'>
export function SecretInput({ className, disabled, ...props }: SecretInputProps) {
  const [revealed, setRevealed] = useState(false)
  return (
    <span className="models-secret">
      <input
        {...props}
        className={`settings-input ${className ?? ''}`}
        disabled={disabled}
        type={revealed ? 'text' : 'password'}
      />
      <button
        aria-label={revealed ? '隐藏 API Key' : '显示 API Key'}
        className="models-secret__toggle"
        disabled={disabled}
        onClick={() => setRevealed((value) => !value)}
        type="button"
      >
        {revealed ? <EyeOff aria-hidden="true" size={15} /> : <Eye aria-hidden="true" size={15} />}
      </button>
    </span>
  )
}

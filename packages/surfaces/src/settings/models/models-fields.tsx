/*
 * 设置 · 模型页的字段控件。
 *
 * 它本来是 ModelsSettings 里的私有函数，厂商卡也要用，所以搬到这里。
 *
 * 这里此前还有一个枚举下拉，是设计系统 Select 的一层包装 —— 而一模一样的另一层包装
 * 同时住在 SettingsSurface 里。上面那句「一份实现」防住了函数层面的复制，没防住包装
 * 层面的复制，因为基元当时逼着每个调用点自己手写同一棵组合树。两层包装都撤了，树回到
 * 基元内部，这个文件也就只剩下它真正独有的那一个控件。
 */

interface SubFieldProps {
  readonly label: string
  readonly placeholder: string
  readonly value: string
  readonly disabled?: boolean
  readonly secret?: boolean
  readonly onChange: (value: string) => void
}

export function SubField({
  label,
  placeholder,
  value,
  disabled = false,
  secret = false,
  onChange,
}: SubFieldProps) {
  return (
    <div className="models-row models-row--field">
      <span className="models-row__name">{label}</span>

      <div className="models-row__control">
        <input
          aria-label={label}
          /*
           * 密码字段上的 autoComplete="off" 不被 Chromium 尊重（WebView2 同源），
           * 于是密码管理器照样接管这一格：自动填充、保存密码气泡，以及它往框里
           * 塞的那颗原生按钮。new-password 是官方留给「这里不要回填」的那个值。
           */
          autoComplete={secret ? 'new-password' : 'off'}
          className="models-input models-input--inline"
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value)
          }}
          placeholder={placeholder}
          type={secret ? 'password' : 'text'}
          value={value}
        />
      </div>
    </div>
  )
}

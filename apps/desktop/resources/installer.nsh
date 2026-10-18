; 安装 / 卸载前把 Poietica 的进程收干净，再确认 exe 不再被占用。
;
; 为什么需要这一份（refactor-log R-37）：
; electron-builder 自带的 CHECK_APP_RUNNING 按**安装目录**枚举进程，只认 Poietica.exe；而本产品还有
; 一个同目录下的 poietica-core.exe：omp 会用 detached 方式从它派发 daemon broker / lsp mux 之类的
; 后台进程，那些进程不在任何进程树里，主程序退出后仍然活着，一直占着
; resources\core\poietica-core.exe。表现出来就是「Poietica 无法关闭」的框，或者带着旧的 core.exe
; 装成「新 app.asar + 旧 core.exe」—— 启动后协议版本对不上，直接 failed/protocol_mismatch，
; 重装也修不好。
;
; 为什么用 taskkill 而不是 PowerShell 的 Win32_Process：NSIS 会把脚本里的 $ 当变量解析，
; PowerShell 的 $_ / $() 必须写成 $$ / $$()，而 $$($INSTDIR) 这种组合展开后是 $(D:\...)，
; PowerShell 会把括号里的路径当命令执行、静默失败 —— 第一版就是这么写坏的（计数永远是 0）。
; taskkill / tasklist 没有这个问题，也够用。
;
; 全程不弹窗：静默安装（/S）下弹窗会卡死。

; 还有没有这个镜像名的进程：$0 == 0 表示「还在」，非 0 表示「没了」
!macro POIETICA_IMAGE_RUNNING _IMAGE _OUT
  nsExec::Exec 'cmd /C tasklist /FI "IMAGENAME eq ${_IMAGE}" /NH | findstr /I /C:"${_IMAGE}"'
  Pop ${_OUT}
!macroend

!macro POIETICA_KILL_INSTALL_DIR_PROCESSES
  Push $R0
  Push $R1
  Push $R2

  ; 先温柔一次：主程序收到关闭请求会自己收尾（关 Core、flush 设置）
  nsExec::Exec 'taskkill /T /IM "Poietica.exe"'
  Pop $R0
  Sleep 600

  StrCpy $R1 0
  poietica_kill_loop:
    ; 强杀：主程序 + 它派发出去、已经不在进程树里的 core 后台进程
    nsExec::Exec 'taskkill /F /T /IM "Poietica.exe"'
    Pop $R0
    nsExec::Exec 'taskkill /F /T /IM "poietica-core.exe"'
    Pop $R0
    Sleep 400

    !insertmacro POIETICA_IMAGE_RUNNING "poietica-core.exe" $R0
    StrCmp $R0 "0" poietica_still_running
    !insertmacro POIETICA_IMAGE_RUNNING "Poietica.exe" $R0
    StrCmp $R0 "0" poietica_still_running
    Goto poietica_kill_done

    poietica_still_running:
    IntOp $R1 $R1 + 1
    IntCmp $R1 10 poietica_kill_done poietica_kill_loop poietica_kill_done

  poietica_kill_done:
  ; 再等一拍，让 Windows 真正释放 exe 映像上的句柄（覆盖安装就靠这一下）
  Sleep 700

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

; 安装与卸载都先走 CHECK_APP_RUNNING：顶掉它自带的检查（那个只按安装目录认 Poietica.exe，
; 还会弹「无法关闭」的框）。
!macro customCheckAppRunning
  !insertmacro POIETICA_KILL_INSTALL_DIR_PROCESSES
!macroend

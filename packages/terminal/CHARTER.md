# Terminal

Owns the terminal session port and its xterm surface. The host owns PTY lifetime; a view owns its xterm instance, listeners and measurements. The root entry exposes the transport-independent port and does not load React or Tauri. /surface owns UI integration. It must not know workbench selection, browser state, review state or assistant composition.

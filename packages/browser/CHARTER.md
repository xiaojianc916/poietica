# Browser

Owns browser-facing host actions and viewport measurement. Native browser state is authoritative and its DTOs are generated from Rust. The public entry uses standard browser APIs but does not load React or Tauri. The native bridge implements the injected host port; workbench panels consume it. It must not import panel orchestration, assistant state, review, or terminal.

# Workbench ownership

- Browser: native browser state -> generated contract -> injected host port -> panels. The native host owns tabs; panels own selection and transient presentation.
- Review: Git -> gateway -> the current observation -> immutable read model -> surface. The store owns draft intent; the surface owns its worker. Late observations cannot publish.
- Terminal: native PTY -> injected session port -> xterm surface. Host PTY lifetime and view lifetime are distinct.
- Composition: workspace-panels owns panel interactions; desktop supplies concrete capabilities. No domain imports composition.

Package exports define the public boundary. Root review and terminal entries are framework independent; their /surface entries own React integration. Browser viewport measurement uses browser standards, not a React runtime.

The architecture gate checks package direction and declarations, production runtime file cycles, literal dynamic loads, unresolved local dependencies, and declared headless entry closures. Type-only contract edges remain governed by package boundary policies. Core tests exercise injected ports without mounting React or starting Tauri.

# Workspace panels

Owns auxiliary panel selection, browser toolbar interactions and panel presentation. It consumes browser actions and injected review/terminal renderers; it does not own Git, PTY processes, native browser state or IPC. Application composition supplies those capabilities. It must not import native-bridge or assistant state.

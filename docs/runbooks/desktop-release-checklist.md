# Desktop release acceptance

This checklist covers native interactions that are not honestly exercised by
the browser-only Vite test environment.

## Window chrome

- [ ] Dragging an empty title-bar region moves the native window.
- [ ] Double-clicking the title bar toggles maximize and restore.
- [ ] Minimize sends the window to the taskbar or dock.
- [ ] Close exits immediately.
- [ ] Interactive buttons do not start window dragging.

## Conversation lifecycle

- [ ] Start a conversation, send a message, close the tab and reopen it from the sidebar.
- [ ] A restored conversation replays its event log without missing frames.
- [ ] Cancelling a run stops the agent without corrupting the thread.

## Settings

- [ ] Theme and language survive restart.
- [ ] Reset restores Rust and TypeScript defaults consistently.

## Update

- [ ] An older build discovers the new release, downloads it and installs it after a restart.
- [ ] Conversations, settings and the agent's own configuration survive the update.
- [ ] The download only fetches the changed blocks, not the whole installer.

## Evidence

Record the tested commit, operating system and result in the release PR.
Do not mark desktop release acceptance complete from unit tests alone.

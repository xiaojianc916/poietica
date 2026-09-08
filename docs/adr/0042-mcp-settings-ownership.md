# MCP settings ownership

## Decision

The settings entry and extension entry render one McpSettings component. PluginStore serializes all MCP file changes and publishes only a successfully read projection; a read failure must not replace the last known inventory with an empty list. The existing generated IPC carries opaque file contents. The native boundary chooses the controlled Agent home and performs the existing conditional write. No new protocol client or IPC schema is introduced.

MCP transport, version negotiation, OAuth and child-process lifetime remain owned by Kimi. The UI presents configuration enablement, never inferred connection health. Batch import is explicit JSON selection, refuses name collisions, and writes the entire selected batch once. Form arguments are a JSON string array, not a shell command string.

## Consequences

Only the controlled Agent user scope is managed here. This decision does not introduce foreign-application discovery, project-scope writes or session health telemetry. Existing curated server discovery remains available. Persisting env or headers stores their literal values in the Agent configuration; the editor warns before submission and recommends bearerTokenEnvVar for remote tokens.

## References

- Kimi MCP configuration and session behavior: https://github.com/MoonshotAI/kimi-code/blob/7f5debfa71ac9e4a23b5dab1a511aa3672677381/docs/en/customization/mcp.md
- Configuration fields: https://github.com/MoonshotAI/kimi-code/blob/7f5debfa71ac9e4a23b5dab1a511aa3672677381/packages/agent-core-v2/src/mcpCore/config-schema.ts
- SDK ownership: https://github.com/MoonshotAI/kimi-code/blob/7f5debfa71ac9e4a23b5dab1a511aa3672677381/packages/agent-core-v2/src/mcpCore/client-stdio.ts

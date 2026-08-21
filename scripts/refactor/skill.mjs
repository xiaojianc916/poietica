export function migrateSkills(m) {
  const contract = 'packages/agent-contract/src/skill.ts'
  m.replace(
    contract,
    `  /** project / user / extra / builtin，由 kap 判定。 */\n  readonly source: string\n`,
    `  /** project / user / extra / builtin，由 kap 判定。 */\n  readonly source: string\n  readonly path: string\n  readonly type?: string | undefined\n  readonly disableModelInvocation?: boolean | undefined\n`,
  )
  m.replace(contract, `  readonly list: (sessionId: string) => Promise<readonly AgentSkill[]>`, `  readonly list: (sessionId?: string) => Promise<readonly AgentSkill[]>`)

  m.replace(
    'crates/agent-runtime/src/session.rs',
    `    /// project / user / extra / builtin。\n    pub source: String,\n`,
    `    /// project / user / extra / builtin。\n    pub source: String,\n    pub path: String,\n    pub kind: Option<String>,\n    pub disable_model_invocation: Option<bool>,\n`,
  )
  m.replace(
    'crates/agent-runtime/src/driver.rs',
    `                source: item\n                    .get(\"source\")\n                    .and_then(Value::as_str)\n                    .unwrap_or(\"\")\n                    .to_owned(),\n`,
    `                source: item\n                    .get(\"source\")\n                    .and_then(Value::as_str)\n                    .unwrap_or(\"\")\n                    .to_owned(),\n                path: item\n                    .get(\"path\")\n                    .and_then(Value::as_str)\n                    .unwrap_or(\"\")\n                    .to_owned(),\n                kind: item.get(\"type\").and_then(Value::as_str).map(str::to_owned),\n                disable_model_invocation: item\n                    .get(\"disable_model_invocation\")\n                    .and_then(Value::as_bool),\n`,
  )

  const dto = 'apps/desktop/src-tauri/src/commands/agent/skill.rs'
  m.replace(
    dto,
    `    /// project / user / extra / builtin，由 kap 判定。\n    pub source: String,\n`,
    `    /// project / user / extra / builtin，由 kap 判定。\n    pub source: String,\n    pub path: String,\n    #[serde(rename = \"type\")]\n    pub kind: Option<String>,\n    pub disable_model_invocation: Option<bool>,\n`,
  )
  m.replace(dto, `    pub session_id: String,`, `    pub session_id: Option<String>,`)
  m.replace(dto, `.skills(request.session_id)`, `.skills(request.session_id.unwrap_or_else(|| live.anchor.clone()))`)
  m.replace(
    dto,
    `            source: skill.source,\n`,
    `            source: skill.source,\n            path: skill.path,\n            kind: skill.kind,\n            disable_model_invocation: skill.disable_model_invocation,\n`,
  )

  m.replace(
    'packages/ipc/src/agent.ts',
    `const listed = await throughIpc(() => commands.agentSkills({ sessionId }))`,
    `const listed = await throughIpc(() => commands.agentSkills({ sessionId: sessionId ?? null }))`,
  )

  const actions = 'packages/agent-ui/src/composer/composer-actions.tsx'
  m.replace(
    actions,
    `  if (skills.length > 0) {`,
    `  const activatableSkills = skills.filter(\n    (skill) =>\n      skill.type === undefined ||\n      skill.type === 'prompt' ||\n      skill.type === 'inline' ||\n      skill.type === 'flow',\n  )\n\n  if (activatableSkills.length > 0) {`,
  )
  m.replace(actions, `      rows: skills.map((skill) => ({`, `      rows: activatableSkills.map((skill) => ({`)
  m.replace(
    actions,
    `        token: skill.source === 'builtin' ? \`/\${skill.name}\` : \`/skill:\${skill.name}\`,`,
    `        token: skill.source === 'builtin' ? \`/\${skill.name}\` : \`/skill:\${skill.name}\`,`,
  )

  m.assertAbsent('readonly source: string\n}', [contract])
}

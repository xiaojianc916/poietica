use poietica_extension_native as extension;
use poietica_kap_client::{McpServer, McpStatus, Skill};
use serde::Serialize;
use sha2::{Digest, Sha256};
use specta::Type;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "snake_case")]
pub enum AgentMcpStatus {
    Connected,
    Connecting,
    Disconnected,
    Error,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentMcpServer {
    pub id: String,
    pub name: String,
    pub status: AgentMcpStatus,
    pub tool_count: u32,
    pub last_error: Option<String>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentSkill {
    pub id: String,
    pub name: String,
    pub description: String,
    pub source: String,
    pub path: String,
    pub project: Option<String>,
    pub project_path: Option<String>,
    pub document: Option<String>,
    pub directory: Option<String>,
    pub enabled: bool,
    pub loaded: bool,
    pub kind: Option<String>,
    pub disable_model_invocation: Option<bool>,
    pub supporting_files: Option<u32>,
    pub total_bytes: Option<u32>,
    pub modified_at: Option<u32>,
}

#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentToolkit {
    pub skills: Vec<AgentSkill>,
    pub mcp_servers: Vec<AgentMcpServer>,
}

// KAP decides effective precedence; managed inventory only enriches that snapshot.
pub fn collect_toolkit(
    root: &Path,
    fallback_cwd: Option<&str>,
    runtime: Vec<Skill>,
    servers: Vec<McpServer>,
) -> extension::Result<AgentToolkit> {
    let managed = extension::scan_skills(root)?;
    let mut by_name = managed
        .into_iter()
        .map(|skill| (skill.name.clone(), skill))
        .collect::<HashMap<_, _>>();
    let mut skills = Vec::with_capacity(runtime.len() + by_name.len());
    for skill in runtime {
        let owned = by_name.remove(&skill.name);
        skills.push(restate_skill(skill, owned.as_ref(), fallback_cwd));
    }
    skills.extend(by_name.into_values().map(restate_unloaded));
    skills.sort_by_key(|skill| skill.name.to_lowercase());

    Ok(AgentToolkit {
        skills,
        mcp_servers: servers.into_iter().map(restate_server).collect(),
    })
}

fn restate_skill(
    skill: Skill,
    managed: Option<&extension::ScannedSkill>,
    fallback_cwd: Option<&str>,
) -> AgentSkill {
    let project_path = (skill.source == "project")
        .then(|| project_root(&skill.path, fallback_cwd))
        .flatten();
    let project = project_path
        .as_deref()
        .and_then(|path| Path::new(path).file_name())
        .map(|name| name.to_string_lossy().into_owned());
    let document = managed
        .map(|item| item.document.clone())
        .or_else(|| read_document(&skill.path));
    let directory = managed.map(|item| item.name.clone());
    let metrics = managed.map(|item| {
        (
            narrow(item.supporting_files.into()),
            narrow(item.total_bytes),
            item.modified_at.map(narrow),
        )
    });
    AgentSkill {
        id: skill_id(&skill.source, &skill.path, &skill.name),
        name: skill.name,
        description: skill.description,
        source: skill.source,
        path: skill.path,
        project,
        project_path,
        document,
        directory,
        enabled: true,
        loaded: true,
        kind: skill.kind,
        disable_model_invocation: skill.disable_model_invocation,
        supporting_files: metrics.map(|item| item.0),
        total_bytes: metrics.map(|item| item.1),
        modified_at: metrics.and_then(|item| item.2),
    }
}

fn restate_unloaded(skill: extension::ScannedSkill) -> AgentSkill {
    let path = skill.directory.to_string_lossy().into_owned();
    AgentSkill {
        id: skill_id("user", &path, &skill.name),
        name: skill.name.clone(),
        description: String::new(),
        source: "user".to_owned(),
        path,
        project: None,
        project_path: None,
        document: Some(skill.document),
        directory: Some(skill.name),
        enabled: skill.enabled,
        loaded: false,
        kind: None,
        disable_model_invocation: None,
        supporting_files: Some(skill.supporting_files),
        total_bytes: Some(narrow(skill.total_bytes)),
        modified_at: skill.modified_at.map(narrow),
    }
}

fn read_document(raw: &str) -> Option<String> {
    if raw.starts_with("builtin:") {
        return None;
    }
    let path = PathBuf::from(raw);
    let document = if path.is_dir() {
        path.join(extension::SKILL_FILENAME)
    } else {
        path
    };
    extension::read_skill_document(&document).ok()
}

fn project_root(skill_path: &str, fallback: Option<&str>) -> Option<String> {
    let path = Path::new(skill_path);
    for ancestor in path.ancestors() {
        if ancestor
            .file_name()
            .is_some_and(|name| name == ".kimi-code" || name == ".agents")
        {
            return ancestor
                .parent()
                .map(|root| root.to_string_lossy().into_owned());
        }
    }
    fallback.map(str::to_owned)
}

fn skill_id(source: &str, path: &str, name: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(source.as_bytes());
    digest.update([0]);
    digest.update(path.as_bytes());
    digest.update([0]);
    digest.update(name.as_bytes());
    hex::encode(digest.finalize())
}

fn narrow(value: u64) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}

fn restate_server(server: McpServer) -> AgentMcpServer {
    AgentMcpServer {
        id: server.id,
        name: server.name,
        status: match server.status {
            McpStatus::Connected => AgentMcpStatus::Connected,
            McpStatus::Connecting => AgentMcpStatus::Connecting,
            McpStatus::Disconnected => AgentMcpStatus::Disconnected,
            McpStatus::Error => AgentMcpStatus::Error,
        },
        tool_count: server.tool_count,
        last_error: server.last_error,
    }
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "test fixtures must fail loudly when filesystem setup fails"
    )]
    use super::{collect_toolkit, read_document, skill_id};
    use poietica_extension_native as extension;
    use std::fs;

    #[test]
    fn managed_skills_remain_visible_when_the_agent_has_not_loaded_them() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let directory = temporary.path().join("review");
        fs::create_dir(&directory).expect("skill directory");
        fs::write(
            directory.join(extension::SKILL_FILENAME),
            "Review carefully.",
        )
        .expect("skill document");
        extension::set_skill_enabled(temporary.path(), "review", false).expect("disable skill");
        let toolkit =
            collect_toolkit(temporary.path(), None, Vec::new(), Vec::new()).expect("toolkit");
        assert_eq!(toolkit.skills.len(), 1);
        let skill = toolkit.skills.first().expect("managed skill");
        assert_eq!(skill.name, "review");
        assert!(!skill.enabled);
        assert!(!skill.loaded);
        assert_eq!(skill.document.as_deref(), Some("Review carefully."));
        assert!(toolkit.mcp_servers.is_empty());
    }

    #[test]
    fn builtin_documents_are_not_files_and_id_segments_are_distinct() {
        assert_eq!(read_document("builtin:read"), None);
        assert_ne!(skill_id("ab", "c", "d"), skill_id("a", "bc", "d"));
    }
}

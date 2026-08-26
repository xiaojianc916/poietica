//! agent 官方 `installed.json` 的保真读改写。
//!
//! 未知字段留在原始 JSON 中；这里只有官方账本的寻址、合并与开关语义，不解释插件清单。

use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use crate::error::{HostError, Result};
use crate::text_file::{read_optional, write_atomic};

const PLUGINS: &str = "plugins";

#[derive(Debug)]
pub struct PluginLedger {
    document: Value,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginRecord {
    pub id: String,
    pub root: Option<PathBuf>,
    pub enabled: bool,
    pub installed_at: Option<String>,
    pub source: String,
    pub original_source: Option<String>,
    pub disabled_mcp_servers: Vec<String>,
}

#[derive(Debug)]
pub struct PluginInstallation {
    pub id: String,
    pub root: PathBuf,
    pub source: String,
    pub original_source: Option<String>,
    pub installed_at: String,
}

impl PluginLedger {
    pub fn read(path: &Path) -> Result<Self> {
        let document = match read_optional(path)? {
            Some(contents) => serde_json::from_str(&contents)?,
            None => json!({ "version": 1, "plugins": [] }),
        };

        Self::from_value(document)
    }

    fn from_value(document: Value) -> Result<Self> {
        if document.get(PLUGINS).and_then(Value::as_array).is_none() {
            return Err(HostError::InvalidLedger(
                "installed.json has no plugins array".to_owned(),
            ));
        }

        Ok(Self { document })
    }

    pub fn records(&self) -> Result<Vec<PluginRecord>> {
        Ok(self.entries()?.iter().filter_map(record_of).collect())
    }

    pub fn install(&mut self, installation: PluginInstallation) -> Result<()> {
        let PluginInstallation {
            id,
            root,
            source,
            original_source,
            installed_at,
        } = installation;
        let existing_at = index_of(self.entries()?, &id);
        let mut fresh = Map::new();

        let _id = fresh.insert("id".to_owned(), json!(id));
        let _root = fresh.insert(
            "root".to_owned(),
            json!(root.to_string_lossy().into_owned()),
        );
        let _source = fresh.insert("source".to_owned(), json!(source));
        let _enabled = fresh.insert("enabled".to_owned(), json!(true));
        let _installed = fresh.insert("installedAt".to_owned(), json!(installed_at.clone()));

        if let Some(original) = original_source {
            let _original = fresh.insert("originalSource".to_owned(), json!(original));
        }

        let entries = self.entries_mut()?;
        match existing_at {
            Some(at) => {
                let existing = entry_at(entries, at)?;

                if let Some(value) = existing.get("installedAt").cloned() {
                    let _kept = fresh.insert("installedAt".to_owned(), value);
                }
                if let Some(value) = existing.get("capabilities").cloned() {
                    let _kept = fresh.insert("capabilities".to_owned(), value);
                }
                let _updated = fresh.insert("updatedAt".to_owned(), json!(installed_at));
                *existing = fresh;
            }
            None => entries.push(Value::Object(fresh)),
        }

        Ok(())
    }

    pub fn remove(&mut self, plugin_id: &str) -> Result<bool> {
        let entries = self.entries_mut()?;
        let Some(at) = index_of(entries, plugin_id) else {
            return Ok(false);
        };

        let _removed = entries.remove(at);
        Ok(true)
    }

    pub fn set_enabled(&mut self, plugin_id: &str, enabled: bool) -> Result<()> {
        let entry = self.entry_mut(plugin_id)?;
        let _previous = entry.insert("enabled".to_owned(), json!(enabled));
        Ok(())
    }

    pub fn set_mcp_enabled(
        &mut self,
        plugin_id: &str,
        server: String,
        enabled: bool,
    ) -> Result<()> {
        let entry = self.entry_mut(plugin_id)?;
        let capabilities = object_entry(entry, "capabilities")?;
        let servers = object_entry(capabilities, "mcpServers")?;
        let state = object_entry(servers, &server)?;
        let _previous = state.insert("enabled".to_owned(), json!(enabled));
        Ok(())
    }

    pub fn write(&self, path: &Path) -> Result<()> {
        let contents = serde_json::to_string_pretty(&self.document)?;
        write_atomic(path, &contents)
    }

    fn entries(&self) -> Result<&Vec<Value>> {
        self.document
            .get(PLUGINS)
            .and_then(Value::as_array)
            .ok_or_else(|| HostError::InvalidLedger("plugins is not an array".to_owned()))
    }

    fn entries_mut(&mut self) -> Result<&mut Vec<Value>> {
        self.document
            .get_mut(PLUGINS)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| HostError::InvalidLedger("plugins is not an array".to_owned()))
    }

    fn entry_mut(&mut self, plugin_id: &str) -> Result<&mut Map<String, Value>> {
        let entries = self.entries_mut()?;
        let at = index_of(entries, plugin_id)
            .ok_or_else(|| HostError::PluginMissing(plugin_id.to_owned()))?;
        entry_at(entries, at)
    }
}

fn index_of(entries: &[Value], plugin_id: &str) -> Option<usize> {
    entries
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str) == Some(plugin_id))
}

fn entry_at(entries: &mut [Value], at: usize) -> Result<&mut Map<String, Value>> {
    entries
        .get_mut(at)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| HostError::InvalidLedger("plugin record is not an object".to_owned()))
}

fn object_entry<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>> {
    parent
        .entry(key.to_owned())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| HostError::InvalidLedger(format!("{key} is not an object")))
}

fn record_of(entry: &Value) -> Option<PluginRecord> {
    let object = entry.as_object()?;
    let id = object.get("id").and_then(Value::as_str)?.to_owned();

    Some(PluginRecord {
        id,
        root: object
            .get("root")
            .and_then(Value::as_str)
            .map(PathBuf::from),
        enabled: object
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        installed_at: string_field(object, "installedAt"),
        source: object
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned(),
        original_source: string_field(object, "originalSource"),
        disabled_mcp_servers: disabled_servers(object),
    })
}

fn string_field(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn disabled_servers(entry: &Map<String, Value>) -> Vec<String> {
    let mut names: Vec<String> = entry
        .get("capabilities")
        .and_then(Value::as_object)
        .and_then(|capabilities| capabilities.get("mcpServers"))
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .iter()
                .filter(|(_, state)| state.get("enabled").and_then(Value::as_bool) == Some(false))
                .map(|(name, _)| name.clone())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "a broken ledger fixture must fail the test loudly"
    )]

    use tempfile::TempDir;

    use super::*;

    fn installation(at: &str) -> PluginInstallation {
        PluginInstallation {
            id: "review".to_owned(),
            root: PathBuf::from("/managed/review"),
            source: "github".to_owned(),
            original_source: Some("owner/review".to_owned()),
            installed_at: at.to_owned(),
        }
    }

    #[test]
    fn a_missing_ledger_starts_empty_and_round_trips() {
        let root = TempDir::new().expect("temporary directory");
        let path = root.path().join("plugins/installed.json");
        let mut ledger = PluginLedger::read(&path).expect("empty ledger");

        ledger.install(installation("first")).expect("install");
        ledger.write(&path).expect("write");

        assert_eq!(
            PluginLedger::read(&path)
                .expect("written ledger")
                .records()
                .expect("records"),
            ledger.records().expect("records")
        );
    }

    #[test]
    fn reinstall_preserves_ordering_time_and_capability_switches() {
        let mut ledger = PluginLedger::from_value(json!({
            "version": 1,
            "plugins": [{
                "id": "review",
                "root": "/old",
                "source": "zip-url",
                "enabled": false,
                "installedAt": "first",
                "capabilities": {
                    "mcpServers": { "browser": { "enabled": false } }
                }
            }]
        }))
        .expect("ledger");

        ledger.install(installation("second")).expect("reinstall");
        let record = ledger
            .records()
            .expect("records")
            .into_iter()
            .next()
            .expect("record");

        assert_eq!(record.installed_at.as_deref(), Some("first"));
        assert_eq!(record.disabled_mcp_servers, vec!["browser"]);
        assert!(record.enabled);
        assert_eq!(
            ledger
                .document
                .get("plugins")
                .and_then(Value::as_array)
                .and_then(|entries| entries.first())
                .and_then(|entry| entry.get("updatedAt"))
                .and_then(Value::as_str),
            Some("second")
        );
    }

    #[test]
    fn mcp_switch_builds_the_official_nested_shape() {
        let mut ledger = PluginLedger::from_value(json!({
            "version": 1,
            "plugins": [{ "id": "review", "root": "/managed/review" }]
        }))
        .expect("ledger");

        ledger
            .set_mcp_enabled("review", "browser".to_owned(), false)
            .expect("toggle");

        assert_eq!(
            ledger
                .records()
                .expect("records")
                .into_iter()
                .next()
                .expect("record")
                .disabled_mcp_servers,
            vec!["browser"]
        );
    }
}

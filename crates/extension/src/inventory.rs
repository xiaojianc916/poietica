//! Kimi Code installed.json 的唯一解释与原子写入点。

use std::path::PathBuf;

use serde_json::{Map, Value, json};

use crate::{ExtensionError, Result, read_optional, write_atomic};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledPlugin {
    pub plugin_id: String,
    pub root: PathBuf,
    pub enabled: bool,
    pub installed_at: Option<String>,
    pub source: String,
    pub original_source: Option<String>,
    pub disabled_mcp_servers: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginReference {
    pub plugin_id: String,
    pub original_source: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginInstall {
    pub plugin_id: String,
    pub root: PathBuf,
    pub source: String,
    pub original_source: Option<String>,
    pub installed_at: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginInventory {
    path: PathBuf,
}

impl PluginInventory {
    #[must_use]
    pub const fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn installed(&self) -> Result<Vec<InstalledPlugin>> {
        let document = self.read()?;
        Ok(entries(&document)?
            .iter()
            .filter_map(|entry| {
                let object = entry.as_object()?;
                let plugin_id = object.get("id")?.as_str()?.to_owned();
                let root = PathBuf::from(object.get("root")?.as_str()?);
                Some(InstalledPlugin {
                    plugin_id,
                    root,
                    enabled: object
                        .get("enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    installed_at: text(object, "installedAt"),
                    source: text(object, "source").unwrap_or_default(),
                    original_source: text(object, "originalSource"),
                    disabled_mcp_servers: disabled_servers(object),
                })
            })
            .collect())
    }

    pub fn references(&self) -> Result<Vec<PluginReference>> {
        let document = self.read()?;
        Ok(entries(&document)?
            .iter()
            .filter_map(|entry| {
                let object = entry.as_object()?;
                Some(PluginReference {
                    plugin_id: object.get("id")?.as_str()?.to_owned(),
                    original_source: text(object, "originalSource"),
                })
            })
            .collect())
    }

    pub fn upsert(&self, install: PluginInstall) -> Result<()> {
        let mut document = self.read()?;
        let rows = entries_mut(&mut document)?;
        let PluginInstall {
            plugin_id,
            root,
            source,
            original_source,
            installed_at,
        } = install;

        if let Some(at) = index_of(rows, &plugin_id) {
            let row = entry_at(rows, at)?;
            let _root = row.insert("root".to_owned(), json!(root.to_string_lossy()));
            let _source = row.insert("source".to_owned(), json!(source));
            let _updated = row.insert("updatedAt".to_owned(), json!(installed_at));
            match original_source {
                Some(value) => {
                    let _original = row.insert("originalSource".to_owned(), json!(value));
                }
                None => {
                    let _removed = row.remove("originalSource");
                }
            }
        } else {
            let mut row = Map::new();
            let _id = row.insert("id".to_owned(), json!(plugin_id));
            let _root = row.insert("root".to_owned(), json!(root.to_string_lossy()));
            let _source = row.insert("source".to_owned(), json!(source));
            let _enabled = row.insert("enabled".to_owned(), json!(true));
            let _installed = row.insert("installedAt".to_owned(), json!(installed_at));
            if let Some(value) = original_source {
                let _original = row.insert("originalSource".to_owned(), json!(value));
            }
            rows.push(Value::Object(row));
        }

        self.write(&document)
    }

    pub fn remove(&self, plugin_id: &str) -> Result<()> {
        let mut document = self.read()?;
        let rows = entries_mut(&mut document)?;
        if let Some(at) = index_of(rows, plugin_id) {
            let _removed = rows.remove(at);
        }
        self.write(&document)
    }

    pub fn set_enabled(&self, plugin_id: &str, enabled: bool) -> Result<()> {
        let mut document = self.read()?;
        let rows = entries_mut(&mut document)?;
        let at = index_of(rows, plugin_id)
            .ok_or_else(|| ExtensionError::MissingPlugin(plugin_id.to_owned()))?;
        let _previous = entry_at(rows, at)?.insert("enabled".to_owned(), json!(enabled));
        self.write(&document)
    }

    pub fn set_mcp_enabled(&self, plugin_id: &str, server: &str, enabled: bool) -> Result<()> {
        let mut document = self.read()?;
        let rows = entries_mut(&mut document)?;
        let at = index_of(rows, plugin_id)
            .ok_or_else(|| ExtensionError::MissingPlugin(plugin_id.to_owned()))?;
        let row = entry_at(rows, at)?;
        let capabilities = object_at(row, "capabilities")?;
        let servers = object_at(capabilities, "mcpServers")?;
        let state = object_at(servers, server)?;
        let _previous = state.insert("enabled".to_owned(), json!(enabled));
        self.write(&document)
    }

    fn read(&self) -> Result<Value> {
        let document = match read_optional(&self.path)? {
            Some(contents) => serde_json::from_str(&contents)?,
            None => json!({ "version": 1, "plugins": [] }),
        };
        let _validated = entries(&document)?;
        Ok(document)
    }

    fn write(&self, document: &Value) -> Result<()> {
        write_atomic(&self.path, &serde_json::to_string_pretty(document)?)
    }
}

fn entries(document: &Value) -> Result<&Vec<Value>> {
    document
        .get("plugins")
        .and_then(Value::as_array)
        .ok_or(ExtensionError::InvalidInventory(
            "installed.json has no plugins array",
        ))
}

fn entries_mut(document: &mut Value) -> Result<&mut Vec<Value>> {
    document
        .get_mut("plugins")
        .and_then(Value::as_array_mut)
        .ok_or(ExtensionError::InvalidInventory(
            "installed.json has no plugins array",
        ))
}

fn index_of(rows: &[Value], plugin_id: &str) -> Option<usize> {
    rows.iter()
        .position(|row| row.get("id").and_then(Value::as_str) == Some(plugin_id))
}

fn entry_at(rows: &mut [Value], at: usize) -> Result<&mut Map<String, Value>> {
    rows.get_mut(at)
        .and_then(Value::as_object_mut)
        .ok_or(ExtensionError::InvalidInventory(
            "installed.json plugin is not an object",
        ))
}

fn object_at<'a>(
    parent: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>> {
    parent
        .entry(key.to_owned())
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or(ExtensionError::InvalidInventory(
            "installed.json nested value is not an object",
        ))
}

fn text(object: &Map<String, Value>, key: &str) -> Option<String> {
    object.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn disabled_servers(entry: &Map<String, Value>) -> Vec<String> {
    let mut names = entry
        .get("capabilities")
        .and_then(Value::as_object)
        .and_then(|value| value.get("mcpServers"))
        .and_then(Value::as_object)
        .map(|servers| {
            servers
                .iter()
                .filter(|(_, state)| state.get("enabled").and_then(Value::as_bool) == Some(false))
                .map(|(name, _)| name.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "a broken test fixture must fail loudly")]

    use serde_json::{Value, json};
    use tempfile::TempDir;

    use super::{PluginInstall, PluginInventory};
    use crate::write_atomic;

    #[test]
    fn mutation_preserves_fields_owned_by_the_agent() {
        let root = TempDir::new().expect("temporary directory");
        let path = root.path().join("installed.json");
        write_atomic(
            &path,
            &json!({
                "version": 1,
                "plugins": [{
                    "id": "alpha",
                    "root": "old",
                    "source": "github",
                    "enabled": false,
                    "installedAt": "old-time",
                    "github": { "installedSha": "abc" },
                    "capabilities": { "mcpServers": { "z": { "enabled": false } } }
                }]
            })
            .to_string(),
        )
        .expect("fixture");
        let ledger = PluginInventory::new(path.clone());
        ledger
            .upsert(PluginInstall {
                plugin_id: "alpha".to_owned(),
                root: root.path().join("new"),
                source: "zip-url".to_owned(),
                original_source: None,
                installed_at: "new-time".to_owned(),
            })
            .expect("upsert");

        let document: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("read ledger"))
                .expect("parse ledger");
        let row = document
            .get("plugins")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(Value::as_object)
            .expect("plugin row");
        assert_eq!(row.get("enabled"), Some(&json!(false)));
        assert_eq!(row.get("installedAt"), Some(&json!("old-time")));
        assert_eq!(row.get("github"), Some(&json!({ "installedSha": "abc" })));
        assert_eq!(row.get("updatedAt"), Some(&json!("new-time")));
    }

    #[test]
    fn disabled_servers_are_read_from_the_official_shape() {
        let root = TempDir::new().expect("temporary directory");
        let path = root.path().join("installed.json");
        write_atomic(
            &path,
            &json!({
                "plugins": [{
                    "id": "alpha", "root": "root", "source": "github",
                    "capabilities": { "mcpServers": {
                        "z": { "enabled": false },
                        "a": { "enabled": false },
                        "on": { "enabled": true }
                    }}
                }]
            })
            .to_string(),
        )
        .expect("fixture");
        let installed = PluginInventory::new(path)
            .installed()
            .expect("installed plugins");
        assert_eq!(
            installed
                .first()
                .expect("installed plugin")
                .disabled_mcp_servers,
            vec!["a", "z"]
        );
    }
}

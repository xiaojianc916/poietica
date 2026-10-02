//! agents.json 档案判读（纯函数）；agents.json 可手改、TS 校验不在此进程，判据在此再立一遍。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use serde_json::Value;

/// 受控 home：变量名 + 宿主已创建好的目录；档案声明了 homeVar 才受控。
#[derive(Debug)]
pub struct ControlledHome {
    pub variable: String,
    pub path: PathBuf,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcessEnvironment {
    pub set: Vec<(String, String)>,
    pub remove: Vec<String>,
}

/// 纯目录名（非路径、不能上行）：这一格接在用户 home 后读文件，手改档案可塞 `..`。
pub fn is_plain_directory_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
}

pub fn own_home_of(agent: &Value) -> Option<String> {
    agent
        .get("ownHomeDirectory")
        .and_then(Value::as_str)
        .filter(|name| is_plain_directory_name(name))
        .map(str::to_owned)
}

pub fn home_var_of(agent: &Value) -> Option<String> {
    agent
        .get("homeVar")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

pub fn declared_env_of(agent: &Value) -> BTreeMap<String, String> {
    agent
        .get("env")
        .and_then(Value::as_object)
        .map(|table| {
            table
                .iter()
                .filter_map(|(name, value)| {
                    value.as_str().map(|text| (name.clone(), text.to_owned()))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn is_process_environment_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 64 {
        return false;
    }

    let mut glyphs = name.chars();
    glyphs
        .next()
        .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
        && glyphs.all(|glyph| glyph == '_' || glyph.is_ascii_alphanumeric())
}

#[must_use]
pub fn unset_env_of(agent: &Value) -> Vec<String> {
    agent
        .get("unsetEnv")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| is_process_environment_name(name))
        .map(str::to_owned)
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// 受控 home 必须压过档案声明：手写的 home 路径可能不存在，受控的是宿主刚建好的。
pub fn launch_env(
    declared: &BTreeMap<String, String>,
    controlled: Option<&ControlledHome>,
    remove: &[String],
) -> ProcessEnvironment {
    let mut env = declared.clone();

    if let Some(home) = controlled {
        let _replaced = env.insert(
            home.variable.clone(),
            home.path.to_string_lossy().into_owned(),
        );
    }

    ProcessEnvironment {
        set: env.into_iter().collect(),
        remove: remove.to_vec(),
    }
}

pub fn program_of(agent: &Value) -> Option<String> {
    agent
        .get("command")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// 桥的入口文件名。`command` 是承载它的运行时（Bun），入口是它要跑的脚本 ——
/// 两格分开写，因为运行时是 PATH 上解析的，而脚本只在随包的目录里。
pub fn entry_of(agent: &Value) -> Option<String> {
    agent
        .get("entry")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty() && !name.contains(['/', '\\']))
        .map(str::to_owned)
}

pub fn args_of(agent: &Value) -> Vec<String> {
    agent
        .get("args")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::is_plain_directory_name;
    use serde_json::json;

    #[test]
    fn a_directory_name_is_a_name_not_a_path() {
        assert!(is_plain_directory_name(".omp"));
        assert!(!is_plain_directory_name(""));
        assert!(!is_plain_directory_name("."));
        assert!(!is_plain_directory_name(".."));
        assert!(!is_plain_directory_name("a/b"));
        assert!(!is_plain_directory_name("a\\b"));
        assert!(!is_plain_directory_name("C:"));
    }

    #[test]
    fn field_readers_take_only_what_the_schema_allows() {
        let agent = json!({
            "command": "poietica-agent",
            "args": ["--mode", 3, "rpc"],
            "homeVar": "PI_CODING_AGENT_DIR",
            "ownHomeDirectory": ".omp",
            "env": { "A": "1", "B": 2 },
            "unsetEnv": ["PSModulePath", 2]
        });

        assert_eq!(super::program_of(&agent).as_deref(), Some("poietica-agent"));
        assert_eq!(super::args_of(&agent), vec!["--mode", "rpc"]);
        assert_eq!(
            super::home_var_of(&agent).as_deref(),
            Some("PI_CODING_AGENT_DIR")
        );
        assert_eq!(super::own_home_of(&agent).as_deref(), Some(".omp"));
        assert_eq!(
            super::declared_env_of(&agent)
                .into_iter()
                .collect::<Vec<_>>(),
            vec![("A".to_owned(), "1".to_owned())]
        );
        assert_eq!(super::unset_env_of(&agent), vec!["PSModulePath"]);
    }

    #[test]
    fn the_controlled_home_variable_overrides_a_declared_one() {
        let declared = [("HOME".to_owned(), "/手写/可能不存在".to_owned())]
            .into_iter()
            .collect();
        let controlled = super::ControlledHome {
            variable: "HOME".to_owned(),
            path: std::path::PathBuf::from("/受控/刚建好"),
        };

        let environment =
            super::launch_env(&declared, Some(&controlled), &["PSModulePath".to_owned()]);

        assert_eq!(
            environment.set,
            vec![("HOME".to_owned(), "/受控/刚建好".to_owned())]
        );
        assert_eq!(environment.remove, vec!["PSModulePath"]);
    }
}

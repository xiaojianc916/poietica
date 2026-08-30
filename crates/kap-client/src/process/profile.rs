//! 接入档案的判读：agents.json 里的一条档案 → 起进程、找 home、装运行时要的事实。
//!
//! 档案的存取归宿主（agents.json 是它的 store）；这里只认档案 JSON 里的字段，
//! 全部是纯函数，有自己的单测。agents.json 可以被手改，TS 侧那道校验不在这个
//! 进程里 —— 凡是会被接去拼路径、交给全局安装的字段，判据在这里再立一遍。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde_json::Value;

/// 档案里声明的安装方式。缺席表示这个 agent 不由我们管安装。
#[derive(Debug)]
pub struct InstallSpec {
    pub package_name: String,
    pub version_args: Vec<String>,
}

/// 受控 home：这家 agent 的配置文件在我们手上时，它在哪、认哪个变量名。
///
/// 路径由宿主算（它拥有磁盘布局）；判据 —— 档案声明了 homeVar 才受控 —— 在这里。
#[derive(Debug)]
pub struct ControlledHome {
    /// 它认自己数据根目录的那个环境变量名。
    pub variable: String,
    /// 已经创建好的目录。
    pub path: PathBuf,
}

/// 一个纯粹的目录名：不是路径，也不能往上走。
///
/// agents.json 是一个可以手改的文件，这一格会被接在用户 home 后面去读文件，
/// 一个 `..` 或者一个分隔符就能把它带到别处。
pub fn is_plain_directory_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':'])
}

/// 档案里声明的、这家 agent 自己那份 home 的目录名（用户 home 之下）。
///
/// 缺失或不是一个纯粹的目录名，都表示我们说不出这一家把配置放在哪 —— 那就
/// 不猜，交给调用方决定怎么说。
pub fn own_home_of(agent: &Value) -> Option<String> {
    agent
        .get("ownHomeDirectory")
        .and_then(Value::as_str)
        .filter(|name| is_plain_directory_name(name))
        .map(str::to_owned)
}

/// 档案声明的 home 环境变量名。缺失表示这个 agent 不接受受控 home。
pub fn home_var_of(agent: &Value) -> Option<String> {
    agent
        .get("homeVar")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
}

/// 档案里声明的非密文启动变量。
///
/// 值不是字符串的条目被丢弃而不是让整次启动失败 —— 一个写坏的档案不该让
/// agent 起不来。
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

/// 启动子进程的环境变量。
///
/// 档案声明的先进去，受控 home 后进去 —— 后者必须压过前者：用户在 env 里手写
/// 的 home 路径可能根本不存在，而受控 home 是宿主刚 create_dir_all 出来的。
pub fn launch_env(
    declared: &BTreeMap<String, String>,
    controlled: Option<&ControlledHome>,
) -> Vec<(String, String)> {
    let mut env = declared.clone();

    if let Some(home) = controlled {
        let _replaced = env.insert(
            home.variable.clone(),
            home.path.to_string_lossy().into_owned(),
        );
    }

    env.into_iter().collect()
}

/// 档案里声明的可执行文件。缺席或为空都交给调用方去说。
pub fn program_of(agent: &Value) -> Option<String> {
    agent
        .get("command")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

/// 档案里声明的启动参数。没有 args 一格不是错误，是空表。
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

/// 读出档案里声明的安装方式。
///
/// 包名的字符集在这里判：这一格会被交给全局安装，一个 `--registry` 形态的
/// token 会被包管理器读成旗标而不是包名。
pub fn install_spec_of(agent: &Value) -> Option<InstallSpec> {
    let install = agent.get("install").and_then(Value::as_object)?;

    let package_name = install
        .get("packageName")
        .and_then(Value::as_str)
        .filter(|name| is_npm_package_name(name))?;

    let version_args = install
        .get("versionArgs")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect::<Vec<String>>()
        })
        .filter(|args| !args.is_empty())
        .unwrap_or_else(|| vec!["--version".to_owned()]);

    Some(InstallSpec {
        package_name: package_name.to_owned(),
        version_args,
    })
}

/// npm 名字里允许的字符：小写字母、数字、`.`、`_`、`-`。斜杠是结构，不进字符集。
fn is_npm_name_glyph(glyph: char) -> bool {
    glyph.is_ascii_lowercase() || glyph.is_ascii_digit() || "._-".contains(glyph)
}

/// 包名的一段（scope 或名字本体）：非空、不以 `.`/`_`/`-` 开头、字符集之内。
///
/// 开头字符的禁令有两个出处：npm 的命名规则不许以 `.` 或 `_` 起头；以 `-` 起头的
/// token 会被包管理器的选项解析器读成旗标而不是包名 —— 这一格要拦的正是它。
fn is_npm_package_segment(segment: &str) -> bool {
    !segment.is_empty()
        && !segment.starts_with(['.', '_', '-'])
        && segment.chars().all(is_npm_name_glyph)
}

/// 会被交给包管理器全局安装的那个包名。
///
/// 形状取自 npm 的命名规则：`name` 或 `@scope/name`，长度上限 214。只判字符集
/// 判不住选项形态的 token，逐段的首字符判得住。
pub fn is_npm_package_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 214 {
        return false;
    }

    let body = name.strip_prefix('@').unwrap_or(name);
    let expected = if name.starts_with('@') { 2 } else { 1 };

    body.split('/').count() == expected && body.split('/').all(is_npm_package_segment)
}

#[cfg(test)]
mod tests {
    use super::{is_npm_package_name, is_plain_directory_name};
    use serde_json::json;

    #[test]
    fn real_package_names_pass_the_gate() {
        assert!(is_npm_package_name("lodash"));
        assert!(is_npm_package_name("@moonshot-ai/kimi-code"));
    }

    #[test]
    fn an_option_shaped_token_is_not_a_package_name() {
        assert!(!is_npm_package_name("--registry"));
        assert!(!is_npm_package_name("-g"));
        assert!(!is_npm_package_name("@scope/-flag"));
    }

    #[test]
    fn npm_forbids_leading_dots_and_underscores() {
        assert!(!is_npm_package_name(".hidden"));
        assert!(!is_npm_package_name("_private"));
        assert!(!is_npm_package_name("@.scope/name"));
    }

    #[test]
    fn the_charset_is_npm_lowercase() {
        assert!(!is_npm_package_name("Lodash"));
        assert!(!is_npm_package_name("pkg name"));
        assert!(!is_npm_package_name("pkg;rm"));
    }

    #[test]
    fn only_the_scoped_shape_may_contain_a_slash() {
        assert!(!is_npm_package_name(""));
        assert!(!is_npm_package_name("a/b"));
        assert!(!is_npm_package_name("@a/b/c"));
        assert!(!is_npm_package_name("@scope"));
        assert!(!is_npm_package_name("@scope/"));
    }

    #[test]
    fn a_directory_name_is_a_name_not_a_path() {
        assert!(is_plain_directory_name(".kimi-code"));
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
            "command": "kimi",
            "args": ["web", 3, "--no-open"],
            "homeVar": "KIMI_CODE_HOME",
            "ownHomeDirectory": ".kimi-code",
            "env": { "A": "1", "B": 2 }
        });

        assert_eq!(super::program_of(&agent).as_deref(), Some("kimi"));
        assert_eq!(super::args_of(&agent), vec!["web", "--no-open"]);
        assert_eq!(
            super::home_var_of(&agent).as_deref(),
            Some("KIMI_CODE_HOME")
        );
        assert_eq!(super::own_home_of(&agent).as_deref(), Some(".kimi-code"));
        assert_eq!(
            super::declared_env_of(&agent)
                .into_iter()
                .collect::<Vec<_>>(),
            vec![("A".to_owned(), "1".to_owned())]
        );
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

        let env = super::launch_env(&declared, Some(&controlled));

        assert_eq!(env, vec![("HOME".to_owned(), "/受控/刚建好".to_owned())]);
    }
}

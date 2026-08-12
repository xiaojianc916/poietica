//! 一份 config.toml 的判读：provider 凭据与默认模型闸门。
//!
//! 判据不是这里定的，是上游 session/new 的闸门定的（`hasUsableConfiguredDefaultModel`，
//! packages/agent-contract-adapter/src/server.ts）。这里是那道闸门在本地的逐字对照，
//! 让界面在用户动手之前就能说出「这个模型能不能开会话」「哪家 provider 配了钥匙」，
//! 而不是等 session/new 用一句 authRequired 事后揭晓。
//!
//! 住在这个 crate 而不是组合根：这些判断不需要 AppHandle/State 就写得出来
//! （AGENTS.md §3 的薄封装判据），在这里它们有自己的单测。读 config.toml 只有一条路：
//! `text.parse::<DocumentMut>()` —— 手写扫描已经在同一个文件上与 agent 各说一套过，
//! 判例记在 `tails_from_config` 的文档里。
//!
//! 密钥经过这里但不停留：`secret_from_config` 的返回值唯一的去处是注入子进程的环境变量。

use std::collections::BTreeMap;
use toml_edit::{DocumentMut, Item, TableLike};

/// 一份 config.toml 里那一家 provider 的表。
///
/// 三处都要它：尾号、完整密钥、闸门那道凭据判断。同一段下钻各写一遍，就是三份
/// 迟早走样的说法。
fn provider_table<'a>(document: &'a DocumentMut, provider_id: &str) -> Option<&'a dyn TableLike> {
    document
        .get("providers")
        .and_then(Item::as_table_like)
        .and_then(|providers| providers.get(provider_id))
        .and_then(Item::as_table_like)
}

/// 这一家 provider 现在配着的 `api_key`；缺席、不是字符串、或者只有空白都是 None。
fn api_key_of(document: &DocumentMut, provider_id: &str) -> Option<String> {
    provider_table(document, provider_id)
        .and_then(|provider| provider.get("api_key"))
        .and_then(Item::as_str)
        .map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
}

/// 一把钥匙露在界面上的那几个字符。
const TAIL_CHARS: usize = 5;

/// 每个 provider 的密钥尾号：provider id → 密钥最后几个字符。
///
/// 读的是 TOML，不是逐行扫。此前这里手写了一套扫描规则，它为自己辩护的原话是
/// 「为五个字符引入一个 TOML 解析器不值当」——而 `toml_edit` 本来就是这个文件的依赖
/// （见文件头的 use），那笔成本一次都没有发生过。手写换来的是三个盲区：
/// `strip_prefix("api_key")` 把 `api_key_id` 也当成 `api_key`，单引号写的密钥一律当没配，
/// 段头认死 `[providers.<id>]` 而认不出带引号的键名。agent 自己读这份文件用的是真
/// 解析器，所以每一个盲区都是同一个文件上我们与 agent 各说一套。
///
/// 界面的行不来自这份表（产地是 provider list），读不到时那一行只显示 id，不编。
pub fn tails_from_config(text: &str) -> BTreeMap<String, String> {
    let Ok(document) = text.parse::<DocumentMut>() else {
        return BTreeMap::new();
    };

    let Some(providers) = document.get("providers").and_then(Item::as_table_like) else {
        return BTreeMap::new();
    };

    providers
        .iter()
        .filter_map(|(provider_id, _)| {
            let key = api_key_of(&document, provider_id)?;
            let mut tail: Vec<char> = key.chars().rev().take(TAIL_CHARS).collect();

            tail.reverse();

            Some((provider_id.to_owned(), tail.into_iter().collect()))
        })
        .collect()
}

/// 这个别名在 `models` 表里声明过没有。
///
/// 读与写共用它。此前写入侧内联写着这三行，读回侧一行都没有 —— 同一个键的两个方向
/// 各带一套规则，迟早对不上，而这一次它们已经对不上了。
pub fn alias_is_declared(document: &DocumentMut, alias: &str) -> bool {
    document
        .get("models")
        .and_then(|models| models.as_table_like())
        .is_some_and(|models| models.contains_key(alias))
}

/// 一份 config.toml 里那个「现在真的能开会话」的默认模型。
///
/// 判据不是「这个键非空」，是上游 session/new 那道闸门的判据本身：别名在 `models` 表里，
/// 且它指向的那一家握着非 OAuth 的凭据。达不到就是 None —— 对闸门而言，一个死别名和
/// 一个空键是同一件事，读回侧没有理由把它们说成两件。
///
/// 这个文件里读 config.toml 只有一条路：`text.parse::<DocumentMut>()`。读一套、写一套
/// 是两份迟早对不上的规则，而手写的那一套已经对不上过：「扫到第一个 `[` 就停」认不出
/// 多行字符串里的方括号，`strip_prefix("api_key")` 认不出 `api_key_id` 不是 `api_key`，
/// 单引号写的密钥它一律当没配。agent 自己读这份文件用的是真解析器。
pub fn usable_default_model(text: &str) -> Option<String> {
    let document = text.parse::<DocumentMut>().ok()?;

    let alias = document
        .get("default_model")?
        .as_str()
        .filter(|alias| !alias.is_empty())?
        .to_owned();

    if !alias_is_declared(&document, &alias) || !alias_has_usable_credentials(&document, &alias) {
        return None;
    }

    Some(alias)
}

/// 上游闸门按 provider 的 `type` 决定「密钥也可以从 env 里来」时读哪个变量名。
///
/// 这张表是 `providerHasNonOAuthCredentials` 那个 switch 的逐字对照
/// （packages/agent-contract-adapter/src/server.ts）。认不出的 type 返回 None，由调用方退成宽松判断。
fn credential_env_key(provider_type: &str) -> Option<&'static str> {
    match provider_type {
        "anthropic" => Some("ANTHROPIC_API_KEY"),
        "openai" | "openai_responses" => Some("OPENAI_API_KEY"),
        "kimi" => Some("KIMI_API_KEY"),
        "google-genai" => Some("GOOGLE_API_KEY"),
        "vertexai" => Some("VERTEXAI_API_KEY"),
        _ => None,
    }
}

/// 这个别名指向的 provider 手里有没有非 OAuth 的凭据。
///
/// 判据不是我们定的，是上游 session/new 的闸门定的：`hasUsableConfiguredDefaultModel`
/// 拿 `config.models[default_model]` 解析出 provider，再要求
/// `providerHasNonOAuthCredentials` 为真，否则配置文件里的 `api_key` 整条不算数、
/// 一律 authRequired。所以这里照抄它的三步（packages/agent-contract-adapter/src/server.ts）：
///
/// 1. provider 名取模型条目里的 `provider`，缺席就退到顶层 `default_provider`；
/// 2. 那一段 `[providers.<name>]` 存在；
/// 3. 段里没有 `oauth`（有就直接判否，哪怕同时写着 `api_key` —— 上游第一行逐字是
///    `if (provider.oauth !== undefined) return false`），且 `api_key` 非空，或者
///    `env` 里那个按 `type` 决定的变量非空。
///
/// 键名不是猜的：上游 packages/agent-core/src/config/toml.ts 用通用的 snake/camel
/// 互转落盘，`defaultProvider` 因此写成 `default_provider`；而 `env` 走 cloneObjectValue，
/// 表内的键原样保留，所以变量名就是 `KIMI_API_KEY` 这种全大写形式。
///
/// 不复刻的只有 vertexai 那条组合分支（`GOOGLE_CLOUD_PROJECT` 加 `GOOGLE_CLOUD_LOCATION`，
/// 或从 `base_url` 的 `-aiplatform.googleapis.com` 后缀反推区域）。那是 Google 专属，我们
/// 的界面配不出这种 provider，抄过来就是第二份迟早与上游走样的规则。对它和任何认不出的
/// type，退成「env 表里有任何一个非空值就放行」—— 宽松只会漏拦，不会误拦一个本来能用的
/// 模型，而漏拦的代价正好是今天的现状，不会更差。
pub fn alias_has_usable_credentials(document: &DocumentMut, alias: &str) -> bool {
    let provider_name = document
        .get("models")
        .and_then(|models| models.as_table_like())
        .and_then(|models| models.get(alias))
        .and_then(|entry| entry.as_table_like())
        .and_then(|entry| entry.get("provider"))
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .or_else(|| {
            document
                .get("default_provider")
                .and_then(|value| value.as_str())
                .map(str::to_owned)
        });

    let Some(provider_name) = provider_name else {
        return false;
    };

    let Some(provider) = provider_table(document, &provider_name) else {
        return false;
    };

    if provider.get("oauth").is_some() {
        return false;
    }

    if api_key_of(document, &provider_name).is_some() {
        return true;
    }

    let Some(env) = provider.get("env").and_then(|env| env.as_table_like()) else {
        return false;
    };

    match provider
        .get("type")
        .and_then(|value| value.as_str())
        .and_then(credential_env_key)
    {
        Some(key) => env
            .get(key)
            .and_then(|value| value.as_str())
            .is_some_and(|value| !value.trim().is_empty()),
        None => env
            .iter()
            .any(|(_, value)| value.as_str().is_some_and(|text| !text.trim().is_empty())),
    }
}

/// 从一份 config.toml 的文本里取出某一家 provider 的完整密钥。
///
/// 与尾号同一条读法（`api_key_of`）。全局 home 与受控 home 读的是同一种文件，
/// 各写一份解析就是给同一个格式留两个迟早走样的说法 —— 此前那两份的注释里
/// 逐字写着「扫描规则与 `tails_from_config` 逐字相同」。
///
/// 密钥本体不离开这条调用链：它唯一的去处是 `agent_cli_exec` 注入子进程的环境变量。
pub fn secret_from_config(text: &str, provider_id: &str) -> Option<String> {
    api_key_of(&text.parse::<DocumentMut>().ok()?, provider_id)
}

#[cfg(test)]
mod tests {
    use super::{secret_from_config, tails_from_config, usable_default_model};

    /// 上游闸门在意的每一格各占一段：正常密钥、单引号密钥、空白密钥、env 凭据、
    /// OAuth、缺 provider 的模型条目。
    const CONFIG: &str = r#"
default_model = "k2"
default_provider = "kimi"

[models.k2]
provider = "kimi"

[models.envy]
provider = "enved"

[models.locked]
provider = "oauthed"

[models.implicit]

[providers.kimi]
type = "kimi"
api_key = "sk-abcde12345"

[providers.quoted]
type = "openai"
api_key = 'q-98765'

[providers.blank]
api_key = "   "

[providers.enved]
type = "kimi"

[providers.enved.env]
KIMI_API_KEY = "from-env"

[providers.oauthed]
type = "kimi"
api_key = "sk-real"

[providers.oauthed.oauth]
expires_at = 1
"#;

    #[test]
    fn tails_read_the_toml_the_agent_reads() {
        let tails = tails_from_config(CONFIG);

        assert_eq!(tails.get("kimi").map(String::as_str), Some("12345"));
        assert_eq!(tails.get("quoted").map(String::as_str), Some("98765"));
        assert_eq!(tails.get("blank"), None);
    }

    #[test]
    fn a_declared_alias_with_a_key_passes_the_gate() {
        assert_eq!(usable_default_model(CONFIG), Some("k2".to_owned()));
    }

    #[test]
    fn a_dead_alias_is_the_same_as_no_default_model() {
        let text = CONFIG.replace(r#"default_model = "k2""#, r#"default_model = "gone""#);

        assert_eq!(usable_default_model(&text), None);
    }

    #[test]
    fn oauth_vetoes_even_a_written_api_key() {
        let text = CONFIG.replace(r#"default_model = "k2""#, r#"default_model = "locked""#);

        assert_eq!(usable_default_model(&text), None);
    }

    #[test]
    fn env_credentials_count_for_a_known_provider_type() {
        let text = CONFIG.replace(r#"default_model = "k2""#, r#"default_model = "envy""#);

        assert_eq!(usable_default_model(&text), Some("envy".to_owned()));
    }

    #[test]
    fn a_model_without_provider_falls_back_to_default_provider() {
        let text = CONFIG.replace(r#"default_model = "k2""#, r#"default_model = "implicit""#);

        assert_eq!(usable_default_model(&text), Some("implicit".to_owned()));
    }

    #[test]
    fn the_full_secret_and_the_tail_read_the_same_key() {
        assert_eq!(
            secret_from_config(CONFIG, "kimi"),
            Some("sk-abcde12345".to_owned())
        );
        assert_eq!(secret_from_config(CONFIG, "blank"), None);
    }
}

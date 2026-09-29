//! 密钥不进 Debug 输出。
//!
//! 这一条有前科：`ModelCatalogOperation` 曾经派生 `Debug`，而 `Create` / `Replace`
//! 里装着 `api_key`。桥认不出某个操作时用 `format!("{other:?}")` 把它拼进错误消息，
//! 那条消息经 Rust 一路走到界面与日志 —— 用户的明文密钥就这样落进了
//! `logs/poietica.log`（2026-09-24 实测，两行）。
//!
//! 判据是 AGENTS.md §5 的「Debug 不打载荷」。这里逐条钉住那几个能装密钥的类型。

#![allow(
    clippy::expect_used,
    reason = "a test proves itself by panicking, so a broken fixture must fail the test"
)]

use poietica_agent_client::{
    CatalogImport, ModelCatalogOperation, ProviderInput, ProviderModelInput, ProviderReplacement,
    ShareOutcome,
};

const CANARY: &str = "sk-SECRET-CANARY";

fn model() -> ProviderModelInput {
    ProviderModelInput {
        model: "m".to_owned(),
        max_context_size: 1,
        display_name: None,
        capabilities: None,
        max_output_size: None,
        support_efforts: None,
        adaptive_thinking: None,
    }
}

fn provider_input() -> ProviderInput {
    ProviderInput {
        id: "p".to_owned(),
        provider_type: "openai".to_owned(),
        api_key: Some(CANARY.to_owned()),
        base_url: Some("https://x.example".to_owned()),
        default_model: None,
        models: vec![model()],
    }
}

/// 一份 Debug 输出里不许出现密钥，也不许出现它被拆开的碎片。
fn assert_clean(rendered: &str, what: &str) {
    assert!(
        !rendered.contains(CANARY),
        "{what} leaked the key verbatim: {rendered}"
    );
    assert!(
        !rendered.contains("SECRET-CANARY"),
        "{what} leaked the key body: {rendered}"
    );
}

#[test]
fn a_create_operation_does_not_print_its_key() {
    let rendered = format!("{:?}", ModelCatalogOperation::Create(provider_input()));
    assert_clean(&rendered, "Create");
    /* 判别式要在，否则错误消息说不出是哪个操作。 */
    assert!(
        rendered.contains("Create"),
        "the kind must survive: {rendered}"
    );
}

#[test]
fn a_replace_operation_does_not_print_its_key() {
    let rendered = format!(
        "{:?}",
        ModelCatalogOperation::Replace {
            provider_id: "p".to_owned(),
            provider: ProviderReplacement {
                new_id: None,
                provider_type: "openai".to_owned(),
                api_key: Some(CANARY.to_owned()),
                base_url: None,
                default_model: None,
                models: vec![model()],
            },
        }
    );
    assert_clean(&rendered, "Replace");
    assert!(rendered.contains('p'), "the id must survive: {rendered}");
}

#[test]
fn the_imports_do_not_print_their_keys() {
    let catalog = format!(
        "{:?}",
        ModelCatalogOperation::ImportCatalog(CatalogImport {
            catalog_id: "c".to_owned(),
            api_key: Some(CANARY.to_owned()),
            base_url: None,
            id: None,
        })
    );
    assert_clean(&catalog, "ImportCatalog");
}

#[test]
fn the_inputs_do_not_print_their_keys() {
    assert_clean(&format!("{:?}", provider_input()), "ProviderInput");
    assert_clean(
        &format!(
            "{:?}",
            ProviderReplacement {
                new_id: None,
                provider_type: "openai".to_owned(),
                api_key: Some(CANARY.to_owned()),
                base_url: None,
                default_model: None,
                models: vec![model()],
            }
        ),
        "ProviderReplacement",
    );
}

/// **分享链接是读取凭据，不是普通 URL。**
///
/// omp 的分享链接形状是 `<serverUrl>/<id>#<key>`，`#` 之后那一截是解密密钥 —— 拿到整个
/// 字符串的人就能读那份分享出去的对话。所以它必须和上面几把模型钥匙同一条纪律：
/// 手写 `Debug`，把 url 折成占位符（`session/client.rs` 的 `impl fmt::Debug for
/// ShareOutcome`）。
///
/// 判据不能只看「代码里有没有手写 Debug」：往 url 里种一串能认出来的值，证明它打不出来。
/// 这条测试的作用是让将来某次「顺手改回 derive」当场变红。
#[test]
fn a_share_link_never_prints_its_decryption_key() {
    const PLANTED: &str = "sk-planted-share-key-must-not-reach-the-log-9f2a";

    let subject = ShareOutcome {
        url: format!("https://my.omp.sh/s/abc123#{PLANTED}"),
        truncated: false,
    };

    let rendered = format!("{subject:?}");

    assert!(
        !rendered.contains(PLANTED),
        "Debug printed the share key: {rendered}"
    );
    assert!(
        !rendered.contains("my.omp.sh"),
        "Debug printed the link: {rendered}"
    );
    /* 非凭据的那一格照打：日志里要认得出这次分享有没有被裁剪过。 */
    assert!(
        rendered.contains("truncated"),
        "the truncation flag must survive: {rendered}"
    );
}

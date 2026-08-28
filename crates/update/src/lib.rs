//! 更新域：清单判读、载荷判定、签名与完整性校验、增量编解码。
//!
//! 不认识 tauri、不做 IO 编排、不知道界面。进程那一端在 apps/desktop。
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::io::{Read as _, Write};
/// 载荷容器头。种类写进字节里，解码方不靠文件名猜。
const MAGIC: &[u8] = b"POIEUP01";
/// 参照前缀要全程可见，窗口就得盖住整份基线：2^27 = 128 MiB。
const WINDOW_LOG: u32 = 27;
/// 发布期压一次，客户端省每一次下行。
const LEVEL: i32 = 19;
#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("payload is not a poietica update payload")]
    Format,
    #[error("payload declares kind {0}, which this build cannot apply")]
    Kind(u8),
    #[error("payload does not match the hash its manifest declares")]
    Hash,
    #[error("payload signature does not verify against the release key")]
    Signature,
    #[error("manifest is malformed: {0}")]
    Manifest(#[from] serde_json::Error),
    #[error("payload codec failed: {0}")]
    Codec(#[from] std::io::Error),
}
pub type Result<T> = std::result::Result<T, UpdateError>;
/// 这一次要取哪种载荷。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PayloadKind {
    /// 相对本机基线的增量。
    Patch,
    /// 整份可执行文件。
    Full,
}
/// 发布清单。客户端与发布脚本读写同一份形状。
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    /// 装上之后那个可执行文件的 BLAKE3。全链路唯一的成品判据。
    pub payload_hash: String,
    pub full: Artifact,
    #[serde(default)]
    pub patches: Vec<Patch>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub url: String,
    /// minisign 签名文件的 base64，与 Tauri 签名器的产物同一形状。
    pub signature: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Patch {
    /// 这条增量要求的基线哈希。
    pub from_hash: String,
    #[serde(flatten)]
    pub artifact: Artifact,
}
/// 选中的那一个载荷。
#[derive(Clone, Copy, Debug)]
pub struct Selection<'a> {
    pub kind: PayloadKind,
    pub url: &'a str,
    pub signature: &'a str,
}
impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        Ok(serde_json::from_slice(bytes)?)
    }
    /// 比装着的这一版新才算更新。判据交给 semver，不比字符串。
    pub fn supersedes(&self, installed: &str) -> bool {
        match (
            semver::Version::parse(&self.version),
            semver::Version::parse(installed),
        ) {
            (Ok(published), Ok(running)) => published > running,
            _ => false,
        }
    }
    /// 基线哈希对得上就走增量；对不上（改过、跳版、首次）就走整包。
    pub fn select(&self, baseline_hash: &str) -> Selection<'_> {
        self.patches
            .iter()
            .find(|patch| patch.from_hash == baseline_hash)
            .map_or(
                Selection {
                    kind: PayloadKind::Full,
                    url: &self.full.url,
                    signature: &self.full.signature,
                },
                |patch| Selection {
                    kind: PayloadKind::Patch,
                    url: &patch.artifact.url,
                    signature: &patch.artifact.signature,
                },
            )
    }
}
/// 可执行文件的身份。
pub fn hash(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}
/// 发布签名校验。公钥与签名都是 minisign 文本的 base64。
pub fn verify(release_key: &str, signature: &str, bytes: &[u8]) -> Result<()> {
    let key = minisign_verify::PublicKey::decode(&decode_text(release_key)?)
        .map_err(|_unusable| UpdateError::Signature)?;
    let signature = minisign_verify::Signature::decode(&decode_text(signature)?)
        .map_err(|_unusable| UpdateError::Signature)?;
    /* 签名器的预散列与直签两种产物都是 ed25519 校验，两种都收。 */
    key.verify(bytes, &signature, true)
        .map_err(|_rejected| UpdateError::Signature)
}
fn decode_text(encoded: &str) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_unusable| UpdateError::Signature)?;
    String::from_utf8(bytes).map_err(|_unusable| UpdateError::Signature)
}
/// 把下行字节还原成可执行文件本体。整包忽略基线。
pub fn decode(kind: PayloadKind, baseline: &[u8], payload: &[u8]) -> Result<Vec<u8>> {
    let body = body_of(kind, payload)?;
    let mut binary = Vec::new();
    match kind {
        PayloadKind::Patch => {
            let mut decoder = zstd::stream::read::Decoder::with_ref_prefix(body, baseline)?;
            decoder.window_log_max(WINDOW_LOG)?;
            decoder.read_to_end(&mut binary)?;
        }
        PayloadKind::Full => {
            let mut decoder = zstd::stream::read::Decoder::with_buffer(body)?;
            decoder.window_log_max(WINDOW_LOG)?;
            decoder.read_to_end(&mut binary)?;
        }
    }
    Ok(binary)
}
/// 发布期生成载荷。增量的基线是上一版那个可执行文件。
pub fn encode(kind: PayloadKind, baseline: &[u8], target: &[u8]) -> Result<Vec<u8>> {
    let mut framed = Vec::with_capacity(MAGIC.len() + 1);
    framed.extend_from_slice(MAGIC);
    framed.push(tag_of(kind));
    let sealed = match kind {
        PayloadKind::Patch => {
            let mut encoder =
                zstd::stream::write::Encoder::with_ref_prefix(framed, LEVEL, baseline)?;
            tune(&mut encoder, target.len())?;
            encoder.write_all(target)?;
            encoder.finish()?
        }
        PayloadKind::Full => {
            let mut encoder = zstd::stream::write::Encoder::new(framed, LEVEL)?;
            tune(&mut encoder, target.len())?;
            encoder.write_all(target)?;
            encoder.finish()?
        }
    };
    Ok(sealed)
}
/// 远距匹配加大窗口：基线里几十 MB 之外的那一段也要能被引用到。
fn tune<W: Write>(
    encoder: &mut zstd::stream::write::Encoder<'_, W>,
    target: usize,
) -> std::io::Result<()> {
    encoder.long_distance_matching(true)?;
    encoder.window_log(WINDOW_LOG)?;
    encoder.set_pledged_src_size(Some(target as u64))
}
const fn tag_of(kind: PayloadKind) -> u8 {
    match kind {
        PayloadKind::Patch => 1,
        PayloadKind::Full => 2,
    }
}
fn body_of(kind: PayloadKind, payload: &[u8]) -> Result<&[u8]> {
    let framed = payload.strip_prefix(MAGIC).ok_or(UpdateError::Format)?;
    let (tag, body) = framed.split_first().ok_or(UpdateError::Format)?;
    if *tag != tag_of(kind) {
        return Err(UpdateError::Kind(*tag));
    }
    Ok(body)
}
#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        reason = "测试断言失败就该炸，转发 Result 只会把失败点藏起来"
    )]
    use super::*;
    const MANIFEST: &str = r#"{
      "version": "0.3.0",
      "notes": null,
      "payloadHash": "cc",
      "full": { "url": "https://example.invalid/full", "signature": "F" },
      "patches": [
        { "fromHash": "aa", "url": "https://example.invalid/patch", "signature": "P" }
      ]
    }"#;
    /* 伪随机基线：整包压不动，增量的便宜才是真便宜。 */
    fn baseline() -> Vec<u8> {
        let mut state: u32 = 0x9E37_79B9;
        (0..400_000)
            .map(|_ignored| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 24) as u8
            })
            .collect()
    }
    #[test]
    fn a_patch_reconstructs_the_target_and_stays_a_fraction_of_it() {
        let base = baseline();
        let mut target = base.clone();
        target.extend_from_slice(b"poietica 0.3.0");
        let payload = encode(PayloadKind::Patch, &base, &target).expect("the patch encodes");
        assert!(
            payload.len() * 20 < target.len(),
            "a one-line change must not cost a whole payload: {} of {}",
            payload.len(),
            target.len()
        );
        assert_eq!(
            decode(PayloadKind::Patch, &base, &payload).expect("the patch applies"),
            target
        );
    }
    #[test]
    fn a_full_payload_reconstructs_without_any_baseline() {
        let target = baseline();
        let payload = encode(PayloadKind::Full, &[], &target).expect("the payload encodes");
        assert_eq!(
            decode(PayloadKind::Full, &[], &payload).expect("the payload decodes"),
            target
        );
    }
    #[test]
    fn foreign_or_mislabelled_bytes_are_refused_instead_of_installed() {
        let patch = encode(PayloadKind::Patch, b"base", b"target").expect("the patch encodes");
        assert!(matches!(
            decode(PayloadKind::Full, &[], b"an installer, not a payload"),
            Err(UpdateError::Format)
        ));
        assert!(matches!(
            decode(PayloadKind::Full, &[], &patch),
            Err(UpdateError::Kind(1))
        ));
    }
    #[test]
    fn the_manifest_picks_a_patch_only_when_the_baseline_matches() {
        let manifest = Manifest::parse(MANIFEST.as_bytes()).expect("the fixture parses");
        assert_eq!(manifest.select("aa").kind, PayloadKind::Patch);
        assert_eq!(manifest.select("bb").kind, PayloadKind::Full);
        assert!(manifest.supersedes("0.2.1"));
        assert!(!manifest.supersedes("0.3.0"));
    }
}

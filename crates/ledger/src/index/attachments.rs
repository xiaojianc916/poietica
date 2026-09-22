//! 附件的账：哪条对话引用着哪几段字节。字节本身按摘要落磁盘，进附件根之后由
//! agent 经 file part 的磁盘路径读取（apps/desktop/src-tauri/src/conversation/）；
//! 这里只回答某条对话引用着哪些字节、哪些字节没人要了。附件不是对话内容，是这
//! 台机器上用户自己的文件。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Result;
use crate::index::store::AgentStore;

/// 一段被某条对话引用着的字节，交付它需要的全部。它不说这张图属于哪句话 ——
/// 那件事写在 agent 的 transcript 上（turn 的 attachmentIds，见 ADR 0050）。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ThreadAttachment {
    /// 小写十六进制 SHA-256。它同时是资产协议里的 asset token。
    pub hash: String,
    pub mime: String,
    pub name: String,
    pub byte_size: i64,
}

impl AgentStore {
    pub fn attachments_of(&self, thread: Uuid) -> Result<Vec<ThreadAttachment>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT link.hash, blob.mime, blob.name, blob.byte_size
               FROM thread_attachments AS link
               JOIN attachments        AS blob ON blob.hash = link.hash
              WHERE link.thread_id = ?1
              ORDER BY link.hash",
        )?;

        let found = statement
            .query_map(rusqlite::params![thread.to_string()], |row| {
                Ok(ThreadAttachment {
                    hash: row.get(0)?,
                    mime: row.get(1)?,
                    name: row.get(2)?,
                    byte_size: row.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(found)
    }

    /// 已经没有任何对话引用的字节。标记清除而非引用计数：计数要求每条增减都
    /// 不出错，这一句只问当下的事实，少一条路径就少一种漂移。数据量是本机发过
    /// 的图片张数，一次全表扫描完全够用。
    pub fn unreferenced_attachments(&self) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT hash
               FROM attachments
              WHERE hash NOT IN (SELECT hash FROM thread_attachments)
              ORDER BY hash",
        )?;

        let found = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(found)
    }

    /// 忘掉一段字节。磁盘上那一份由调用方在这之后删：先删行后删文件，崩在中间
    /// 只是没人认领的文件、下次扫描自愈；反过来就是一条指向空文件的账。
    pub fn forget_attachment(&self, hash: &str) -> Result<()> {
        self.write(
            "DELETE FROM attachments WHERE hash = ?1",
            rusqlite::params![hash],
        )
    }

    // 对话删除的多表事务由 threads.rs 单点持有。
}

pub(crate) fn remember_in(
    transaction: &rusqlite::Transaction<'_>,
    timestamp: &str,
    thread: Uuid,
    attachment: &ThreadAttachment,
) -> Result<()> {
    transaction.execute(
        "INSERT INTO attachments (hash, mime, name, byte_size, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (hash) DO NOTHING",
        rusqlite::params![
            attachment.hash,
            attachment.mime,
            attachment.name,
            attachment.byte_size,
            timestamp
        ],
    )?;
    transaction.execute(
        "INSERT INTO thread_attachments (thread_id, hash)
         VALUES (?1, ?2) ON CONFLICT (thread_id, hash) DO NOTHING",
        rusqlite::params![thread.to_string(), attachment.hash],
    )?;
    Ok(())
}

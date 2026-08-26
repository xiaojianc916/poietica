//! 附件的账:哪条对话引用着哪几段字节。
//!
//! 字节本身不在这个 crate 里,也不在这个库文件里 —— 它们按摘要落在磁盘上,
//! 由桌面层的资产协议交付(asset_protocol.rs)。这里只回答两个问题:某条对话
//! 该显示哪些附件,以及哪些字节已经没有人要了。
//!
//! 这与 lib.rs 那句「对话说过什么不在这里」并不矛盾。附件不是对话内容,是
//! **这台机器上的用户自己的文件**:agent 收到的是一份 base64 副本,它没有义务
//! 交还,多数 CLI 也确实不交还。归属清楚,存放的地方才清楚。

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Result;
use crate::store::{AgentStore, now};

/// 一段被某条对话引用着的字节,交付它需要的全部。
///
/// 它不说这张图属于哪一句话 —— 那件事写在帧上(prompt_admitted 的 images)。
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ThreadAttachment {
    /// 小写十六进制 SHA-256。它同时是资产协议里的 asset token。
    pub hash: String,
    pub mime: String,
    pub byte_size: i64,
}

impl AgentStore {
    /// 记下一段字节的存在,以及它挂在哪里。
    ///
    /// 两张表一次事务。分开写就会出现「链接指向一段不存在的字节」的中间态,
    /// 而那正是回收逻辑会照着删的东西。
    ///
    /// 同一张图发第二次不是错误:摘要相同,`attachments` 那一行原样保留
    /// (`ON CONFLICT DO NOTHING`),只多一条链接。这就是内容寻址省下的那份拷贝。
    ///
    /// # Errors
    ///
    /// 事务被拒时返回错误。
    pub fn remember_attachment(
        &mut self,
        thread: Uuid,
        attachment: &ThreadAttachment,
    ) -> Result<()> {
        let timestamp = now()?;
        let transaction = self.connection.transaction()?;

        transaction.execute(
            "INSERT INTO attachments (hash, mime, byte_size, created_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (hash) DO NOTHING",
            rusqlite::params![
                &attachment.hash,
                &attachment.mime,
                attachment.byte_size,
                timestamp
            ],
        )?;

        transaction.execute(
            "INSERT INTO thread_attachments (thread_id, hash)
             VALUES (?1, ?2)
             ON CONFLICT (thread_id, hash) DO NOTHING",
            rusqlite::params![thread.to_string(), &attachment.hash],
        )?;

        transaction.commit()?;

        Ok(())
    }

    /// 这条对话的全部附件,按它们出现的顺序。
    ///
    /// 顺序由 SQL 给,不由调用方再排一遍:认领方是顺着时间线往下走的,拿到
    /// 一份已经同序的表就只需要走一趟。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
    pub fn attachments_of(&self, thread: Uuid) -> Result<Vec<ThreadAttachment>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT link.hash, blob.mime, blob.byte_size
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
                    byte_size: row.get(2)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(found)
    }

    /// 已经没有任何对话引用的字节。
    ///
    /// 标记清除,不是引用计数。计数要求每一条增减都不出错,而删对话、删轮次、
    /// 迁移失败各是一条路径;这一句问的是当下的事实,少走一条路径就少一种漂移。
    /// 数据量是这台机器上发过的图片张数,一次全表扫描完全够用。
    ///
    /// # Errors
    ///
    /// 查询被拒时返回错误。
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

    /// 忘掉一段字节。磁盘上那一份由调用方在这之后删。
    ///
    /// 顺序是刻意的:先删文件后删行,崩在中间就是一条指向空文件的账;先删行后
    /// 删文件,崩在中间就是一个没人认领的文件,而它下一次扫描就会被再次发现。
    /// 两种残留只有后一种是自愈的。
    ///
    /// # Errors
    ///
    /// 删除被拒时返回错误。
    pub fn forget_attachment(&self, hash: &str) -> Result<()> {
        self.write(
            "DELETE FROM attachments WHERE hash = ?1",
            rusqlite::params![hash],
        )
    }

    // 对话删除的多表事务由 threads.rs 单点持有。
}

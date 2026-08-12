//! Conversations: their names, their sessions, and their place in the list.

use rusqlite::types::{FromSql, FromSqlResult, ToSql, ToSqlOutput, ValueRef};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Result;
use crate::store::{AgentStore, now};

impl AgentStore {
    /// Creates a thread and returns its identifier.
    ///
    /// `workspace_root` 是这条对话开在哪个目录里。空表示默认那一个工作区 ——
    /// 迁移 0013 之前写下的行都是空的，含义相同，所以它可空而不是必填。
    ///
    /// # Errors
    ///
    /// Fails when the insert is rejected.
    pub fn create_thread(&self, title: &str, workspace_root: Option<&str>) -> Result<Uuid> {
        let id = Uuid::now_v7();
        let timestamp = now()?;

        self.write(
            "INSERT INTO threads (id, title, created_at, updated_at, workspace_root)
             VALUES (?1, ?2, ?3, ?3, ?4)",
            rusqlite::params![id.to_string(), title, timestamp, workspace_root],
        )?;

        Ok(id)
    }

    /// Lists every thread, most recently touched first.
    ///
    /// # Errors
    ///
    /// Fails when the query is rejected.
    // 没被说过话的对话不进列表。判据此前是「有没有 runs 行」，而本地已经
    // 不再记轮次。同一件事现在由名字回答：一条对话的名字取自它的第一句话
    // （record_prompt），所以还挂着占位名的，就是还没有人开口的那一条。
    // 迁移 0009 在删表之前把存量对齐过，列表成员一行不差。
    pub fn list_threads(&self) -> Result<Vec<ThreadSummary>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT id, session_id, agent_id, title, title_source, updated_at, pinned,
                    workspace_root, archived_at
               FROM threads
              WHERE title_source <> 'fallback'
              ORDER BY pinned DESC, updated_at DESC",
        )?;

        let found = statement
            .query_map([], |row| {
                Ok(ThreadSummary {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    agent_id: row.get(2)?,
                    title: row.get(3)?,
                    title_source: row.get(4)?,
                    updated_at: row.get(5)?,
                    pinned: row.get::<_, i64>(6)? != 0,
                    workspace_root: row.get(7)?,
                    archived_at: row.get(8)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(found)
    }

    /// Records which agent session a thread is holding, and whose it is.
    ///
    /// 两件事一起写，因为分开写就有一瞬间是号在而人不在，而那正是这一列要
    /// 消灭的状态。迁移 0012 起这不再只是这里的自觉：库上有触发器，把号写进
    /// 去而不写下主人会被直接拒。
    ///
    /// `updated_at` is left alone. Reopening a conversation from a previous
    /// run makes it take a fresh session, and a conversation last spoken in
    /// a week ago is still a week old after being looked at. Touching the
    /// column here sent whatever was opened to the top of the list, which
    /// is the opposite of what opening it was for.
    pub fn attach_session(&self, id: Uuid, session_id: &str, agent_id: &str) -> Result<()> {
        self.write(
            "UPDATE threads
                SET session_id = ?2, agent_id = ?3
              WHERE id = ?1",
            rusqlite::params![id.to_string(), session_id, agent_id],
        )?;

        Ok(())
    }

    /// Reads one conversation, whether or not anything has been said in it.
    ///
    /// [`Self::list_threads`] leaves out a conversation with no runs,
    /// because a list of conversations is a list of the ones that happened.
    /// Reading back the conversation that was just created is a different
    /// question, and asking the list it is deliberately absent from was how
    /// opening one came to fail every single time.
    ///
    /// # Errors
    ///
    /// Fails when the query is rejected.
    pub fn thread(&self, id: Uuid) -> Result<Option<ThreadSummary>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT id, session_id, agent_id, title, title_source, updated_at, pinned,
                    workspace_root, archived_at
               FROM threads
              WHERE id = ?1",
        )?;

        let mut rows = statement.query(rusqlite::params![id.to_string()])?;

        match rows.next()? {
            Some(row) => Ok(Some(ThreadSummary {
                id: row.get(0)?,
                session_id: row.get(1)?,
                agent_id: row.get(2)?,
                title: row.get(3)?,
                title_source: row.get(4)?,
                updated_at: row.get(5)?,
                pinned: row.get::<_, i64>(6)? != 0,
                workspace_root: row.get(7)?,
                archived_at: row.get(8)?,
            })),
            None => Ok(None),
        }
    }

    /// 记下这条对话刚被说了一句话。
    ///
    /// 一句话是两个事实，而它们的频率不同：这条对话**刚刚有活动**，每一轮都
    /// 成立；这条对话**叫什么**，只由第一句话回答一次。
    ///
    /// 此前它们共用一条 `WHERE title_source = 'fallback'`：那个条件是为第二个
    /// 事实准备的，却把第一个也一并守掉了。于是在一条旧对话里继续说话，整条
    /// 语句被拒，`updated_at` 一动不动 —— 而列表正是按它排序（见 `list_threads`
    /// 的 `ORDER BY`）。屏幕上的表现是：刚说过话的对话不会浮上来，永远停在它
    /// 第一句话的时间上。
    ///
    /// 两个事实因此写进同一条语句、各带各的条件：时间无条件更新，名字只在还
    /// 没有名字的时候写。一次往返，一条写路径，没有第二处需要保持同步。
    ///
    /// 命名仍然只发生一次：后一轮的开场白改不动一条已经有名字的对话，用户手
    /// 打的名字（`manual`）更不会被它顶掉。`list_threads` 用「标题源还是
    /// fallback」判断有没有人开过口，这条语句让那个判据继续成立。
    /// 返回的是这一句话在这条对话里的序号，从 0 数起。
    ///
    /// 附件挂在「第几条用户消息」上（见迁移 0010），而这里是这个程序里唯一
    /// 记下一条用户消息的地方 —— 所以这个数只能由这条语句自己给出。让调用方
    /// 去数，等于开出第二个真值来源，而两个来源迟早会分叉。
    ///
    /// `RETURNING` 让加一与读回落在同一条语句里，中间没有别人插得进来的缝。
    ///
    /// 点名一条不存在的对话现在是错误，此前是无声成功：一条 `UPDATE` 影响零行
    /// 不算失败，于是渲染层送来一个陌生的 id 时，这一轮被安静地记进了虚空。
    ///
    /// # Errors
    ///
    /// 语句被拒、或这条对话不存在时返回错误。
    pub fn record_prompt(&self, id: Uuid, title: &str) -> Result<i64> {
        let timestamp = now()?;

        let turn = self
            .connection
            .prepare_cached(
                "UPDATE threads
                    SET title        = CASE WHEN title_source = ?4 THEN ?2 ELSE title END,
                        title_source = CASE WHEN title_source = ?4 THEN ?5 ELSE title_source END,
                        updated_at   = ?3,
                        prompts      = prompts + 1
                  WHERE id = ?1
              RETURNING prompts - 1",
            )?
            .query_row(
                rusqlite::params![
                    id.to_string(),
                    title,
                    timestamp,
                    TitleSource::Fallback,
                    TitleSource::Message,
                ],
                |row| row.get(0),
            )?;

        Ok(turn)
    }

    /// Names a conversation on the user's say-so.
    ///
    /// Recorded as its own source because it outranks the opening message it
    /// replaces: someone has answered this question by hand, so nothing
    /// derived from the text gets to answer it again.
    pub fn name_by_user(&self, id: Uuid, title: &str) -> Result<()> {
        self.write(
            "UPDATE threads
                SET title = ?2, title_source = ?3
              WHERE id = ?1",
            rusqlite::params![id.to_string(), title, TitleSource::Manual],
        )?;

        Ok(())
    }

    /// Holds a conversation at the top of the list, or releases it.
    ///
    /// Pinning is not activity, so the timestamp is left alone: a
    /// conversation pinned today does not become today's conversation.
    pub fn set_pinned(&self, id: Uuid, pinned: bool) -> Result<()> {
        self.write(
            "UPDATE threads SET pinned = ?2 WHERE id = ?1",
            rusqlite::params![id.to_string(), i64::from(pinned)],
        )?;

        Ok(())
    }

    /// Changes whether a conversation belongs to the active list.
    ///
    /// 归档不是删除。标题、会话号、工作区、附件关系与轮次计时全部保留，
    /// 这里只写一枚时间戳。取消归档把时间戳清空。
    pub fn set_archived(&self, id: Uuid, archived: bool) -> Result<()> {
        let archived_at = if archived { Some(now()?) } else { None };

        self.write(
            "UPDATE threads SET archived_at = ?2 WHERE id = ?1",
            rusqlite::params![id.to_string(), archived_at],
        )?;

        Ok(())
    }

    /// Deletes a conversation from the local index.
    ///
    /// 一行没了就是没了：这张表底下已经不挂任何东西。对话在 agent 那边的
    /// 那一份由 session/delete 去删，两边各删各的一份，这里不越权。
    ///
    /// # Errors
    ///
    /// Fails when the delete is rejected.
    pub fn delete_thread(&self, id: Uuid) -> Result<()> {
        /*
         * 链接由这里解，不指望外键。
         *
         * SQLite 的外键约束默认是关的，要靠每条连接自己开 PRAGMA；0010 里那两个
         * REFERENCES 因此只保证得了「写进去的引用是真的」，保证不了「删掉之后没
         * 有悬空的引用」。把清理写在这里，一个删除动作一个主人，不依赖一个必须
         * 逐连接确认的开关。
         *
         * 字节不在这一步删：它可能还挂在别的对话上，这正是内容寻址的意义。
         * 没人要的那些由 unreferenced_attachments 一次扫出来。
         */
        self.release_attachments(id)?;
        self.release_turn_spans(id)?;
        self.write(
            "DELETE FROM threads WHERE id = ?1",
            rusqlite::params![id.to_string()],
        )?;

        Ok(())
    }

    /// 是否仍有对话开在这个工作目录里。
    ///
    /// 删除的路上用它判断目录还有没有主人：无项目工作目录与最后一条指着它
    /// 的对话同寿，多条对话共用一个目录时，先删的那几条不许拆别人的家。
    ///
    /// # Errors
    ///
    /// Fails when the query is rejected.
    pub fn workspace_root_in_use(&self, workspace_root: &str) -> Result<bool> {
        let held: i64 = self
            .connection
            .prepare_cached("SELECT EXISTS (SELECT 1 FROM threads WHERE workspace_root = ?1)")?
            .query_row(rusqlite::params![workspace_root], |row| row.get(0))?;

        Ok(held != 0)
    }

    /// 仍被引用的工作目录，每个一次。
    ///
    /// 启动对账拿它当「不许动」名单：无项目目录里不在名单上的都是没有主人
    /// 的遗留（见 paths.rs 的 sweep_projectless_workspaces）。
    ///
    /// # Errors
    ///
    /// Fails when the query is rejected.
    pub fn workspace_roots(&self) -> Result<Vec<String>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT DISTINCT workspace_root FROM threads WHERE workspace_root IS NOT NULL",
        )?;

        let found = statement
            .query_map([], |row| row.get(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;

        Ok(found)
    }
}

/// One conversation, as a list of conversations needs it.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ThreadSummary {
    /// The thread identifier, as text.
    pub id: String,
    /// The agent session it is holding, where it holds one.
    pub session_id: Option<String>,
    /// 开出那个会话的 agent。
    ///
    /// 空值只有一个意思：这条对话还没有握住会话。上一格与这一格要么都有、
    /// 要么都没有 —— 迁移 0012 把存量里「有号无主」的行补实，并用触发器堵住
    /// 了再造出一行的路，所以拿会话号去选连接的人不必准备一条空值分支。
    pub agent_id: Option<String>,
    /// The name currently shown for it.
    pub title: String,
    /// Where that name came from.
    pub title_source: TitleSource,
    /// When it was last touched, in RFC 3339.
    pub updated_at: String,
    /// Whether it is held at the top of the list.
    pub pinned: bool,
    /// 这条对话开在哪个工作目录里。
    ///
    /// 空是迁移 0013 之前写下的行，含义是「默认那一个工作区」，不是「不知道」：
    /// 那时候运行期只有一个工作目录，它们本来就都在它里面。
    pub workspace_root: Option<String>,
    /// 归档时间。空表示仍在活动列表中。
    pub archived_at: Option<String>,
}

/// Where a thread name came from, in the order they outrank each other.
///
/// Naming a conversation is this program's job. There was a fourth source
/// above all of these, taken from the agent's own session list, on the
/// reasoning that the agent is the authority on what its session is called.
/// It is the authority on that, and that is a different question: the name
/// is whatever the agent wrote in its own store when the session was
/// created, and an agent under no obligation to ever revise it will not.
/// Ranking it above what the user actually typed is how a list of
/// conversations became a column of the words New Session.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TitleSource {
    /// Taken from the first thing the user said, which is what a
    /// conversation in a list should read as.
    Message,
    /// Shown before there was anything to take a name from.
    Fallback,
    /// The user typed it. Nothing derived replaces it.
    Manual,
}

impl TitleSource {
    /// The text this source is stored as.
    ///
    /// One table, not two. serde's `rename_all` encodes the same three
    /// spellings for the wire and the two happened to agree; two encodings of
    /// one closed set is how they stop agreeing.
    const fn as_str(self) -> &'static str {
        match self {
            Self::Message => "message",
            Self::Fallback => "fallback",
            Self::Manual => "manual",
        }
    }
}

impl ToSql for TitleSource {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::from(self.as_str()))
    }
}

impl FromSql for TitleSource {
    fn column_result(value: ValueRef<'_>) -> FromSqlResult<Self> {
        match value.as_str()? {
            "message" => Ok(Self::Message),
            "manual" => Ok(Self::Manual),
            // Anything else is a row an older build wrote, and the only value
            // that ever was is the deleted fourth source. It outranked the
            // name the user typed; read back at the lowest rank the stored
            // title still shows and no longer outranks anything. Refusing the
            // row instead would take the whole sidebar down over one value.
            _ => Ok(Self::Fallback),
        }
    }
}

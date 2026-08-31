//! 本机伪终端：PTY、子进程与回放窗口的唯一所有者。
//!
//! 这一层不认识窗口、事件系统与序列化。字节从读线程出来，先落回放再交给调用方
//! 注入的 sink；谁渲染、怎么送出去都在宿主那一侧，所以本 crate 能在没有窗口的
//! 进程里跑完单测。

mod shell;

pub use shell::Shell;

use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::thread::JoinHandle;

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

/// 回放窗口的上界。越界时最老的整块出队 —— 按块丢至少不会切开一条转义序列。
const REPLAY_BYTES: usize = 256 * 1024;

/// 一次 read 的上界。PTY 内核缓冲本身成块到达，攒批交给渲染层的写队列。
const READ_BYTES: usize = 32 * 1024;

/// 通道上的一件事。
#[derive(Debug)]
pub enum TerminalSignal {
    /// PTY 吐出来的原始字节。VTE 解析归渲染层的终端模拟器。
    Output(Vec<u8>),
    /// shell 已退出。
    Exited,
}

/// 字节离开本 crate 的那一跳。显式注入，不摸全局。
pub type TerminalSink = Arc<dyn Fn(&str, TerminalSignal) + Send + Sync>;

/// 这一层能失败的全部方式。
#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("terminal working directory is not a directory: {0}")]
    WorkingDirectory(String),
    #[error("terminal could not start: {0}")]
    Start(String),
    #[error("terminal control failed: {0}")]
    Control(String),
    #[error("terminal session is not open: {0}")]
    Unknown(String),
    #[error("terminal io failed: {0}")]
    Io(#[from] std::io::Error),
}

fn hold<T>(lock: &Mutex<T>) -> MutexGuard<'_, T> {
    lock.lock().unwrap_or_else(PoisonError::into_inner)
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(1),
        cols: cols.max(2),
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// 回放窗口：这条会话上过屏的字节，截到上界。
#[derive(Debug, Default)]
struct Replay {
    chunks: VecDeque<Vec<u8>>,
    bytes: usize,
    exited: bool,
}

impl Replay {
    fn push(&mut self, chunk: &[u8]) {
        self.chunks.push_back(chunk.to_vec());
        self.bytes = self.bytes.saturating_add(chunk.len());

        while self.bytes > REPLAY_BYTES {
            match self.chunks.pop_front() {
                Some(oldest) => self.bytes = self.bytes.saturating_sub(oldest.len()),
                None => break,
            }
        }
    }

    fn joined(&self) -> Vec<u8> {
        let mut joined = Vec::with_capacity(self.bytes);

        for chunk in &self.chunks {
            joined.extend_from_slice(chunk);
        }

        joined
    }
}

/// 一条会话：一个 PTY、一个子进程、一条读线程、一份回放。
struct Session {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
    replay: Arc<Mutex<Replay>>,
    stopped: Arc<AtomicBool>,
    reader: JoinHandle<()>,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Session")
    }
}

impl Session {
    fn open(
        key: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
        sink: &TerminalSink,
    ) -> Result<Self, TerminalError> {
        if !cwd.is_dir() {
            return Err(TerminalError::WorkingDirectory(cwd.display().to_string()));
        }

        let pair = native_pty_system()
            .openpty(size(cols, rows))
            .map_err(|error| TerminalError::Start(error.to_string()))?;

        let shell = Shell::user();
        let mut command = CommandBuilder::new(shell.program);

        for argument in shell.args {
            command.arg(argument);
        }

        command.cwd(cwd);
        /* 终端能力由这两个变量声明；渲染层那台模拟器报的就是这一档。 */
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| TerminalError::Start(error.to_string()))?;

        /* 从属端就地丢掉：留着它，主端永远读不到 EOF。 */
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| TerminalError::Start(error.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| TerminalError::Start(error.to_string()))?;

        let replay = Arc::new(Mutex::new(Replay::default()));
        let stopped = Arc::new(AtomicBool::new(false));
        let pump = spawn_pump(
            key.to_owned(),
            reader,
            Arc::clone(&replay),
            Arc::clone(&stopped),
            Arc::clone(sink),
        )?;

        Ok(Self {
            master: pair.master,
            writer,
            child,
            replay,
            stopped,
            reader: pump,
        })
    }

    fn resize(&self, cols: u16, rows: u16) -> Result<(), TerminalError> {
        self.master
            .resize(size(cols, rows))
            .map_err(|error| TerminalError::Control(error.to_string()))
    }

    /// 收场。主端是这条伪终端的最后一个持有者：放掉它读端才会 EOF，join 才有上界。
    fn shutdown(self) {
        self.stopped.store(true, Ordering::Release);

        let mut child = self.child;
        let _ = child.kill();

        drop(self.writer);
        drop(self.master);

        let _ = child.wait();
        let _ = self.reader.join();
    }
}

/// 读线程：先落回放，再交 sink，两件事在同一把锁里 —— 顺序即不变量。
fn spawn_pump(
    key: String,
    mut reader: Box<dyn Read + Send>,
    replay: Arc<Mutex<Replay>>,
    stopped: Arc<AtomicBool>,
    sink: TerminalSink,
) -> Result<JoinHandle<()>, TerminalError> {
    std::thread::Builder::new()
        .name("poietica-terminal".to_owned())
        .spawn(move || {
            let mut buffer = vec![0_u8; READ_BYTES];

            loop {
                if stopped.load(Ordering::Acquire) {
                    return;
                }

                let read = match reader.read(&mut buffer) {
                    Ok(read) => read,
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    /* 主端在子进程收场时报错，与 EOF 是同一件事。 */
                    Err(_) => 0,
                };

                if stopped.load(Ordering::Acquire) {
                    return;
                }

                let mut held = hold(&replay);

                if read == 0 {
                    held.exited = true;
                    sink(&key, TerminalSignal::Exited);
                    return;
                }

                let chunk = buffer.get(..read).unwrap_or_default();

                held.push(chunk);
                sink(&key, TerminalSignal::Output(chunk.to_vec()));
            }
        })
        .map_err(TerminalError::Io)
}

/// 会话表：开、写、量、关都从这里过。宿主 manage 一份。
#[derive(Debug, Default)]
pub struct TerminalSessions {
    open: Mutex<HashMap<String, Session>>,
}

impl TerminalSessions {
    /// 接上这个键的会话；没有就按 cwd 开一条。
    ///
    /// 回放经同一个 sink 交回，而且是在回放锁里发出的 —— 读线程也在同一把锁里
    /// 先落回放再交 sink，于是「回放 + 实时」在这一个通道上恰好一次、不乱序。
    /// 新开的会话没有回放可放：读线程吐出的第一块就是这条流的开头。
    pub fn attach(
        &self,
        key: &str,
        cwd: &Path,
        cols: u16,
        rows: u16,
        sink: &TerminalSink,
    ) -> Result<(), TerminalError> {
        let mut open = hold(&self.open);

        if !open.contains_key(key) {
            open.insert(key.to_owned(), Session::open(key, cwd, cols, rows, sink)?);

            return Ok(());
        }

        let Some(session) = open.get(key) else {
            return Err(TerminalError::Unknown(key.to_owned()));
        };

        /* 重新接上时面板可能已经换了宽度：网格先对齐，再回放。 */
        session.resize(cols, rows)?;

        let replay = hold(&session.replay);

        sink(key, TerminalSignal::Output(replay.joined()));

        if replay.exited {
            sink(key, TerminalSignal::Exited);
        }

        Ok(())
    }

    /// 键盘与粘贴的字节。
    pub fn write(&self, key: &str, bytes: &[u8]) -> Result<(), TerminalError> {
        if bytes.is_empty() {
            return Ok(());
        }

        let mut open = hold(&self.open);
        let session = open
            .get_mut(key)
            .ok_or_else(|| TerminalError::Unknown(key.to_owned()))?;

        session.writer.write_all(bytes)?;
        session.writer.flush()?;

        Ok(())
    }

    /// 渲染层量出来的网格。
    pub fn resize(&self, key: &str, cols: u16, rows: u16) -> Result<(), TerminalError> {
        hold(&self.open)
            .get(key)
            .ok_or_else(|| TerminalError::Unknown(key.to_owned()))?
            .resize(cols, rows)
    }

    /// 关掉这条会话。
    pub fn close(&self, key: &str) -> bool {
        /* 摘除在表锁里，拆卸在锁外：等读线程醒过来的那段时间不该停掉整张表。 */
        let Some(session) = hold(&self.open).remove(key) else {
            return false;
        };

        session.shutdown();

        true
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "测试内的失败就该当场炸")]

    use super::{REPLAY_BYTES, Replay, TerminalError, TerminalSessions, TerminalSink};
    use std::sync::Arc;

    #[test]
    fn the_replay_window_keeps_the_newest_bytes_within_its_bound() {
        let mut replay = Replay::default();
        let block = vec![b'x'; REPLAY_BYTES / 2];

        replay.push(&block);
        replay.push(&block);
        replay.push(b"tail");

        assert!(replay.joined().len() <= REPLAY_BYTES);
        assert!(replay.joined().ends_with(b"tail"));
    }

    #[test]
    fn a_working_directory_that_is_not_a_directory_is_refused() {
        let sessions = TerminalSessions::default();
        let sink: TerminalSink = Arc::new(|_, _| {});
        let file = std::env::current_exe().unwrap();

        assert!(matches!(
            sessions.attach("key", &file, 80, 24, &sink),
            Err(TerminalError::WorkingDirectory(_))
        ));
    }

    #[test]
    fn driving_a_session_that_is_not_open_is_reported_rather_than_ignored() {
        let sessions = TerminalSessions::default();

        assert!(matches!(
            sessions.write("key", b"ls"),
            Err(TerminalError::Unknown(_))
        ));
        assert!(matches!(
            sessions.resize("key", 80, 24),
            Err(TerminalError::Unknown(_))
        ));
        assert!(!sessions.close("key"));
    }

    #[test]
    fn a_closed_session_can_be_attached_again() {
        let sessions = TerminalSessions::default();
        let sink: TerminalSink = Arc::new(|_, _| {});
        let cwd = std::env::temp_dir();

        assert!(sessions.attach("key", &cwd, 80, 24, &sink).is_ok());
        assert!(sessions.close("key"));
        /* 拆卸若留在表锁里等读线程，下面这句会挂住而不是通过。 */
        assert!(sessions.attach("key", &cwd, 80, 24, &sink).is_ok());
        assert!(sessions.close("key"));
    }
}

//! 工作树此刻相对 HEAD 的变更面。
//!
//! 清单走 `git status --porcelain=v2 -z`：v2 是 git 给机器读者定的稳定格式，
//! `-z` 让路径按 NUL 分隔，带空格与非 ASCII 的路径不需要反引号解码。
//! `--no-renames` 让重命名照实报成一删一增 —— 审查列表一行一个路径。

use std::collections::HashMap;
use std::path::Path;

use crate::{GitError, expect_ok, inside_work_tree, run};

/// 一个文件此刻的处境。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeStatus {
    /// 新增。
    Added,
    /// 改动。
    Modified,
    /// 删除。
    Deleted,
    /// 还没被跟踪。
    Untracked,
    /// 合并冲突未解决。
    Conflicted,
}

/// 工作树里一处变更。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileChange {
    /// 仓库根的相对路径，正斜杠 —— git 自己的说法。
    pub path: String,
    /// 它此刻的处境。
    pub status: ChangeStatus,
    /// 暂存区里也有这次改动（porcelain v2 的 X 位不是 '.'）。
    pub staged: bool,
    /// 相对 HEAD 新增的行数。二进制、未跟踪、没有 HEAD 都数不出来，那就是 0。
    pub additions: u32,
    /// 相对 HEAD 删除的行数。
    pub deletions: u32,
}

const STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--no-renames",
];

/* 与 patch() 同一条 git diff HEAD：徽章上的数字与展开后画出的行同源。 */
const NUMSTAT_ARGS: &[&str] = &[
    "diff",
    "HEAD",
    "--numstat",
    "-z",
    "--no-renames",
    "--no-ext-diff",
];

/// 问一个目录此刻的变更清单。不是 git 工作区、或机器没有 git，都是 None。
pub async fn changes(root: &Path) -> Result<Option<Vec<FileChange>>, GitError> {
    if !inside_work_tree(root).await? {
        return Ok(None);
    }

    let output = expect_ok(run(root, STATUS_ARGS).await?)?;
    let counted = line_counts(root).await?;
    let mut list = decode(&String::from_utf8_lossy(&output.stdout));

    for change in &mut list {
        if let Some(&(additions, deletions)) = counted.get(&change.path) {
            change.additions = additions;
            change.deletions = deletions;
        }
    }

    Ok(Some(list))
}

/// 一个文件此刻相对 HEAD 的统一补丁。`--` 之后 git 不再把参数读成开关。
pub async fn patch(root: &Path, path: &str) -> Result<String, GitError> {
    let output = expect_ok(
        run(
            root,
            &["diff", "HEAD", "--no-color", "--no-ext-diff", "--", path],
        )
        .await?,
    )?;

    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// 每个路径的加减行数。没有第一个提交时 HEAD 不存在，没有基线可数。
async fn line_counts(root: &Path) -> Result<HashMap<String, (u32, u32)>, GitError> {
    let head = run(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).await?;

    if !head.status.success() {
        return Ok(HashMap::new());
    }

    let output = expect_ok(run(root, NUMSTAT_ARGS).await?)?;

    Ok(numstat(&String::from_utf8_lossy(&output.stdout)))
}

fn numstat(records: &str) -> HashMap<String, (u32, u32)> {
    records.split('\0').filter_map(numstat_entry).collect()
}

/* 一条记录是 <加> TAB <减> TAB <路径>；二进制文件两个数都是 - 。 */
fn numstat_entry(record: &str) -> Option<(String, (u32, u32))> {
    let mut fields = record.split('\t');
    let additions = fields.next()?.parse().unwrap_or_default();
    let deletions = fields.next()?.parse().unwrap_or_default();

    Some((fields.next()?.to_owned(), (additions, deletions)))
}

fn decode(records: &str) -> Vec<FileChange> {
    records.split('\0').filter_map(entry).collect()
}

fn entry(record: &str) -> Option<FileChange> {
    let (marker, rest) = record.split_once(' ')?;

    match marker {
        "1" => ordinary(rest),
        "u" => unmerged(rest),
        "?" => Some(FileChange {
            path: rest.to_owned(),
            status: ChangeStatus::Untracked,
            staged: false,
            additions: 0,
            deletions: 0,
        }),
        _ => None,
    }
}

/* 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path> */
fn ordinary(rest: &str) -> Option<FileChange> {
    let mut fields = rest.splitn(8, ' ');
    let marks = fields.next()?;
    let path = fields.nth(6)?;
    let (status, staged) = decode_marks(marks)?;

    Some(FileChange {
        path: path.to_owned(),
        status,
        staged,
        additions: 0,
        deletions: 0,
    })
}

/* u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path> */
fn unmerged(rest: &str) -> Option<FileChange> {
    let mut fields = rest.splitn(10, ' ');
    fields.next()?;

    Some(FileChange {
        path: fields.nth(8)?.to_owned(),
        status: ChangeStatus::Conflicted,
        staged: false,
        additions: 0,
        deletions: 0,
    })
}

fn decode_marks(marks: &str) -> Option<(ChangeStatus, bool)> {
    let mut chars = marks.chars();
    let index = chars.next()?;
    let worktree = chars.next()?;
    let status = match if worktree == '.' { index } else { worktree } {
        'A' => ChangeStatus::Added,
        'D' => ChangeStatus::Deleted,
        'M' | 'T' => ChangeStatus::Modified,
        _ => return None,
    };

    Some((status, index != '.'))
}

#[cfg(test)]
mod tests {
    use super::{ChangeStatus, decode, numstat};

    #[test]
    fn porcelain_v2_records_are_decoded() {
        let records = [
            "1 .M N... 100644 100644 100644 aaa bbb src/a b.ts",
            "1 A. N... 000000 100644 100644 000000 ccc docs/new.md",
            "? notes/draft.txt",
            "u UU N... 100644 100644 100644 100644 d1 d2 d3 src/conflict.ts",
        ]
        .join("\0");

        let decoded = decode(&records);

        assert_eq!(decoded.len(), 4);
        assert_eq!(decoded[0].path, "src/a b.ts");
        assert_eq!(decoded[0].status, ChangeStatus::Modified);
        assert!(!decoded[0].staged);
        assert_eq!(decoded[1].status, ChangeStatus::Added);
        assert!(decoded[1].staged);
        assert_eq!(decoded[2].status, ChangeStatus::Untracked);
        assert_eq!(decoded[3].status, ChangeStatus::Conflicted);
        assert_eq!(decoded[3].path, "src/conflict.ts");
    }

    #[test]
    fn numstat_records_are_decoded() {
        let records = ["12\t3\tsrc/a b.ts", "-\t-\tlogo.png", "0\t224\tAGENTS.md"].join("\0");
        let counted = numstat(&records);

        assert_eq!(counted.get("src/a b.ts"), Some(&(12, 3)));
        assert_eq!(counted.get("logo.png"), Some(&(0, 0)));
        assert_eq!(counted.get("AGENTS.md"), Some(&(0, 224)));
    }

    #[test]
    fn the_trailing_separator_is_not_an_entry() {
        assert_eq!(decode("? a.txt\0").len(), 1);
    }
}

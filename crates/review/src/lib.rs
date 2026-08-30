//! 审查面的领域模型：变更清单、快照与提交意图。
//!
//! 解码是纯函数：porcelain v2 的记录与表头在这里变成类型，跑 git、拼快照的
//! 活在 git-adapter。同一条记录只有这一处解释。

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
}

/// 审查这一格此刻需要的全部事实。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReviewSnapshot {
    /// 当前检出的分支；HEAD 分离时为 None。
    pub branch: Option<String>,
    /// HEAD 分离时所在提交的短号。
    pub detached_at: Option<String>,
    /// 当前分支的上游引用；没有配置时为 None。
    pub upstream: Option<String>,
    /// 相对上游领先的提交数。
    pub ahead: u32,
    /// 相对上游落后的提交数。
    pub behind: u32,
    /// 本地分支，按最近提交排序。
    pub branches: Vec<String>,
    /// 变更清单，按 git status 的顺序。
    pub changes: Vec<FileChange>,
    /// 整棵工作树相对基准的统一补丁，未跟踪文件在尾部追加。
    pub patch: String,
}

/// 一次提交动作的意图：三个动作三条路，界面不靠一个动作替人决定要不要联网。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitIntent {
    Commit,
    CommitAndPush,
    Push,
}

/// 解一条 porcelain v2 的普通/未合并/未跟踪记录。不认识的记录交回 None，
/// 由调用方决定丢弃还是报错。
#[must_use]
pub fn parse_entry(record: &str) -> Option<FileChange> {
    let (marker, rest) = record.split_once(' ')?;
    match marker {
        "1" => ordinary(rest),
        "u" => unmerged(rest),
        "?" => Some(FileChange {
            path: rest.to_owned(),
            status: ChangeStatus::Untracked,
            staged: false,
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

/// 读一条 porcelain v2 的分支表头（# branch.oid / branch.head /
/// branch.upstream / branch.ab）。
pub fn read_header(held: &mut ReviewSnapshot, header: &str) {
    let Some((key, value)) = header.split_once(' ') else {
        return;
    };
    match key {
        "branch.oid" => {
            held.detached_at = if value == "(initial)" {
                None
            } else {
                Some(value.chars().take(7).collect())
            };
        }
        "branch.head" => {
            held.branch = if value == "(detached)" {
                None
            } else {
                Some(value.to_owned())
            };
        }
        "branch.upstream" => held.upstream = Some(value.to_owned()),
        "branch.ab" => {
            let mut counts = value.split(' ');
            held.ahead = counts.next().and_then(signed).unwrap_or_default();
            held.behind = counts.next().and_then(signed).unwrap_or_default();
        }
        _ => {}
    }
}

/* ab 表头是 +<领先> -<落后>：符号属于格式，数字才是答案。 */
fn signed(field: &str) -> Option<u32> {
    field.get(1..)?.parse().ok()
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::indexing_slicing,
        reason = "fixtures index a Vec whose length the line just above asserts"
    )]
    use super::{ChangeStatus, ReviewSnapshot, parse_entry, read_header};

    fn blank() -> ReviewSnapshot {
        ReviewSnapshot {
            branch: None,
            detached_at: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            branches: Vec::new(),
            changes: Vec::new(),
            patch: String::new(),
        }
    }

    #[test]
    fn porcelain_v2_records_are_decoded() {
        let decoded: Vec<_> = [
            "1 .M N... 100644 100644 100644 aaa bbb src/a b.ts",
            "1 A. N... 000000 100644 100644 000000 ccc docs/new.md",
            "? notes/draft.txt",
            "u UU N... 100644 100644 100644 100644 d1 d2 d3 src/conflict.ts",
            "",
        ]
        .into_iter()
        .filter_map(parse_entry)
        .collect();
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
    fn branch_headers_carry_upstream_and_divergence() {
        let mut held = blank();
        for header in [
            "branch.oid 0123456789abcdef",
            "branch.head main",
            "branch.upstream origin/main",
            "branch.ab +2 -1",
        ] {
            read_header(&mut held, header);
        }
        assert_eq!(held.branch.as_deref(), Some("main"));
        assert_eq!(held.upstream.as_deref(), Some("origin/main"));
        assert_eq!(held.ahead, 2);
        assert_eq!(held.behind, 1);
    }
}

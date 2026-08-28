//! 工作树此刻相对某个基准的审查面：一次问答交回分支、清单与整份补丁。
//!
//! 清单走 `git status --porcelain=v2 -z --branch`：v2 是 git 给机器读者定的稳定格式，
//! 分支表头在同一次里带回 head、upstream 与 ahead/behind。补丁走一条 git diff，
//! 加减行数由补丁自己数出 —— 徽章与画面同源，不存在第二个数法。
use crate::{GitError, expect_ok, inside_work_tree, local_branches, run};
use std::path::Path;
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
/* 整份文件：unified 给到行数不可能达到的量级，折叠带上的行数才是真数字。 */
const WHOLE: u32 = 100_000;
const STATUS_ARGS: &[&str] = &[
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
    "--no-renames",
];
/// 一次问答交回审查面。不是 git 工作区、或机器没有 git，都是 None。
pub async fn review(
    root: &Path,
    base: &str,
    context: u32,
    ignore_whitespace: bool,
) -> Result<Option<ReviewSnapshot>, GitError> {
    checked("比较基准", base)?;
    if !inside_work_tree(root).await? {
        return Ok(None);
    }
    let status = expect_ok(run(root, STATUS_ARGS).await?)?;
    let mut held = ReviewSnapshot {
        branch: None,
        detached_at: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        branches: local_branches(root).await?,
        changes: Vec::new(),
        patch: String::new(),
    };
    for record in String::from_utf8_lossy(&status.stdout).split('\0') {
        match record.strip_prefix("# ") {
            Some(header) => read_header(&mut held, header),
            None => held.changes.extend(entry(record)),
        }
    }
    /* oid 表头永远在；短号只在分离 HEAD 时是答案。 */
    if held.branch.is_some() {
        held.detached_at = None;
    }
    held.patch = patch(root, base, context, ignore_whitespace, &held.changes, None).await?;
    Ok(Some(held))
}
/// 一个文件相对基准的整份补丁：折叠带上的行由它带回来，取回时机由界面决定。
///
/// 走的仍是审查面那条 patch，只把范围收到一个路径 —— 未跟踪文件照样与空文件比。
pub async fn file_patch(
    root: &Path,
    base: &str,
    path: &str,
    ignore_whitespace: bool,
) -> Result<String, GitError> {
    checked("比较基准", base)?;
    checked("路径", path)?;
    let mut args = STATUS_ARGS.to_vec();
    args.extend(["--", path]);
    let listed = expect_ok(run(root, &args).await?)?;
    let records = String::from_utf8_lossy(&listed.stdout);
    let changes: Vec<FileChange> = records
        .split('\0')
        .filter(|record| !record.starts_with("# "))
        .filter_map(entry)
        .collect();
    patch(root, base, WHOLE, ignore_whitespace, &changes, Some(path)).await
}
/// 一次提交动作的意图：三个动作三条路，界面不靠一个动作替人决定要不要联网。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CommitIntent {
    Commit,
    CommitAndPush,
    Push,
}

/// 按意图暂存、提交、推送，交回新的审查面。
pub async fn commit(
    root: &Path,
    intent: CommitIntent,
    message: &str,
    stage_all: bool,
    base: &str,
    context: u32,
    ignore_whitespace: bool,
) -> Result<ReviewSnapshot, GitError> {
    let held = refreshed(root, base, context, ignore_whitespace).await?;
    if intent != CommitIntent::Push {
        let subject = message.trim();
        if subject.is_empty() {
            return Err(GitError::Refused("提交需要一条说明".to_owned()));
        }
        if stage_all {
            expect_ok(run(root, &["add", "--all"]).await?)?;
        }
        expect_ok(run(root, &["commit", "--message", subject]).await?)?;
    }
    if intent != CommitIntent::Commit {
        let push: &[&str] = if held.upstream.is_some() {
            &["push"]
        } else {
            &["push", "--set-upstream", "origin", "HEAD"]
        };
        expect_ok(run(root, push).await?)?;
    }
    refreshed(root, base, context, ignore_whitespace).await
}
async fn refreshed(
    root: &Path,
    base: &str,
    context: u32,
    ignore_whitespace: bool,
) -> Result<ReviewSnapshot, GitError> {
    review(root, base, context, ignore_whitespace)
        .await?
        .ok_or_else(|| GitError::Refused("这个目录已经不是 git 工作区".to_owned()))
}
fn read_header(held: &mut ReviewSnapshot, header: &str) {
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
/* 只挡把参数读成命令行开关的那一类注入；其余交给 git 自己解释。 */
fn checked(kind: &str, value: &str) -> Result<(), GitError> {
    if value.trim().is_empty() || value.starts_with('-') {
        return Err(GitError::Refused(format!("无效的{kind}：{value}")));
    }
    Ok(())
}
/* ab 表头是 +<领先> -<落后>：符号属于格式，数字才是答案。 */
fn signed(field: &str) -> Option<u32> {
    field.get(1..)?.parse().ok()
}
/// core.quotePath=false 让非 ASCII 路径原样出现在文件头，解析侧不需要第二份
/// 反引号解码器。
async fn patch(
    root: &Path,
    base: &str,
    context: u32,
    ignore_whitespace: bool,
    changes: &[FileChange],
    only: Option<&str>,
) -> Result<String, GitError> {
    let unified = format!("--unified={context}");
    let mut text = String::new();
    if run(root, &["rev-parse", "--verify", "--quiet", base])
        .await?
        .status
        .success()
    {
        let mut args = vec![
            "-c",
            "core.quotePath=false",
            "diff",
            base,
            "--no-color",
            "--no-ext-diff",
            "--no-renames",
            unified.as_str(),
        ];
        if ignore_whitespace {
            args.push("--ignore-all-space");
        }
        if let Some(scope) = only {
            args.extend(["--", scope]);
        }
        text.push_str(&String::from_utf8_lossy(
            &expect_ok(run(root, &args).await?)?.stdout,
        ));
    }
    for change in changes {
        if change.status == ChangeStatus::Untracked {
            text.push_str(
                &untracked(root, unified.as_str(), ignore_whitespace, &change.path).await?,
            );
        }
    }
    Ok(text)
}
/* 未跟踪文件没有基线，与空文件比。--no-index 蕴含 --exit-code：1 是「有差异」。 */
async fn untracked(
    root: &Path,
    unified: &str,
    ignore_whitespace: bool,
    path: &str,
) -> Result<String, GitError> {
    let mut args = vec![
        "-c",
        "core.quotePath=false",
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        unified,
    ];
    if ignore_whitespace {
        args.push("--ignore-all-space");
    }
    args.extend(["--", "/dev/null", path]);
    let output = run(root, &args).await?;
    if output.status.code().unwrap_or_default() > 1 {
        return expect_ok(output).map(|_| String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
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
#[cfg(test)]
mod tests {
    #![allow(
        clippy::indexing_slicing,
        reason = "fixtures index a Vec whose length the line just above asserts"
    )]
    use super::{ChangeStatus, ReviewSnapshot, entry, read_header};
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
        .filter_map(entry)
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

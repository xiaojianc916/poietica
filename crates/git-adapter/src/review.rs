//! 审查面：清单走 porcelain=v2、补丁走一条 git diff；porcelain 记录的解释在 crates/review，这里只跑命令、拼快照。

use std::path::{Path, PathBuf};

use futures::{StreamExt as _, stream};
use poietica_review_native::{
    ChangeStatus, CommitIntent, FileChange, ReviewSnapshot, parse_entry, read_header,
};

use crate::{
    GitError, branch_listing, branches_from, expect_ok, git_missing, is_work_tree,
    repository_probe, run, still_a_worktree,
};

/* 整份文件：unified 给到行数不可能达到的量级，折叠带上的行数才是真数字。 */
const WHOLE: u32 = 100_000;
const UNTRACKED_CONCURRENCY: usize = 4;
/// 让非 ASCII 路径原样出现在文件头，解析侧不需要第二份反引号解码器。
const QUOTE_PATH_OFF: &str = "core.quotePath=false";
const STATUS_ARGS: &[&str] = &[
    "--no-optional-locks",
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
    "--no-renames",
];

pub async fn review(
    root: &Path,
    base: &str,
    context: u32,
    ignore_whitespace: bool,
) -> Result<Option<ReviewSnapshot>, GitError> {
    checked("比较基准", base)?;
    let queried = tokio::try_join!(
        repository_probe(root),
        run(root, STATUS_ARGS),
        branch_listing(root),
        base_exists(root, base),
    );
    let (probe, status, branches, base_exists) = match queried {
        Ok(outputs) => outputs,
        Err(error) if git_missing(&error) => return Ok(None),
        Err(error) => return Err(error),
    };

    if !is_work_tree(&probe) {
        return Ok(None);
    }

    let status = expect_ok(status)?;
    let mut held = ReviewSnapshot {
        branch: None,
        detached_at: None,
        upstream: None,
        ahead: 0,
        behind: 0,
        branches: branches_from(branches)?,
        changes: Vec::new(),
        patch: String::new(),
    };
    for record in String::from_utf8_lossy(&status.stdout).split('\0') {
        match record.strip_prefix("# ") {
            Some(header) => read_header(&mut held, header),
            None => held.changes.extend(parse_entry(record)),
        }
    }
    if held.branch.is_some() {
        held.detached_at = None;
    }
    held.patch = patch(
        root,
        base,
        context,
        ignore_whitespace,
        &held.changes,
        None,
        base_exists,
    )
    .await?;
    Ok(Some(held))
}

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
    let (listed, base_exists) = tokio::try_join!(run(root, &args), base_exists(root, base))?;
    let listed = expect_ok(listed)?;
    let records = String::from_utf8_lossy(&listed.stdout);
    let changes: Vec<FileChange> = records
        .split('\0')
        .filter(|record| !record.starts_with("# "))
        .filter_map(parse_entry)
        .collect();
    patch(
        root,
        base,
        WHOLE,
        ignore_whitespace,
        &changes,
        Some(path),
        base_exists,
    )
    .await
}

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
    still_a_worktree(review(root, base, context, ignore_whitespace).await?)
}

/* 只挡把参数读成命令行开关的那一类注入；其余交给 git 自己解释。 */
pub(crate) fn checked(kind: &str, value: &str) -> Result<(), GitError> {
    if value.trim().is_empty() || value.starts_with('-') {
        return Err(GitError::Refused(format!("无效的{kind}：{value}")));
    }
    Ok(())
}

async fn base_exists(root: &Path, base: &str) -> Result<bool, GitError> {
    Ok(run(root, &["rev-parse", "--verify", "--quiet", base])
        .await?
        .status
        .success())
}

async fn patch(
    root: &Path,
    base: &str,
    context: u32,
    ignore_whitespace: bool,
    changes: &[FileChange],
    only: Option<&str>,
    base_exists: bool,
) -> Result<String, GitError> {
    let unified = format!("--unified={context}");
    let (tracked, untracked) = tokio::join!(
        tracked_patch(
            root,
            base,
            unified.as_str(),
            ignore_whitespace,
            only,
            base_exists,
        ),
        untracked_patches(root, unified.as_str(), ignore_whitespace, changes),
    );
    let mut text = tracked?;
    for addition in untracked? {
        text.push_str(&addition);
    }
    Ok(text)
}

/// tracked 与 untracked 共用的 diff 旗标：mode 里是各自特有的前置参，尾参由调用方补。
fn diff_args<'a>(mode: &[&'a str], unified: &'a str, ignore_whitespace: bool) -> Vec<&'a str> {
    let mut args = vec!["-c", QUOTE_PATH_OFF, "diff"];
    args.extend_from_slice(mode);
    args.extend(["--no-color", "--no-ext-diff", unified]);
    if ignore_whitespace {
        args.push("--ignore-all-space");
    }
    args
}

async fn tracked_patch(
    root: &Path,
    base: &str,
    unified: &str,
    ignore_whitespace: bool,
    only: Option<&str>,
    base_exists: bool,
) -> Result<String, GitError> {
    if !base_exists {
        return Ok(String::new());
    }

    let mut args = diff_args(&[base, "--no-renames"], unified, ignore_whitespace);
    if let Some(scope) = only {
        args.extend(["--", scope]);
    }
    Ok(String::from_utf8_lossy(&expect_ok(run(root, &args).await?)?.stdout).into_owned())
}

async fn untracked_patches(
    root: &Path,
    unified: &str,
    ignore_whitespace: bool,
    changes: &[FileChange],
) -> Result<Vec<String>, GitError> {
    /* future 只带自有数据：借用条目的 future 过不了 command 宏的高阶 lifetime 边界（见 apps/desktop/src-tauri/src/review.rs）。 */
    let pending: Vec<(PathBuf, String, String)> = changes
        .iter()
        .filter(|change| change.status == ChangeStatus::Untracked)
        .map(|change| (root.to_path_buf(), unified.to_owned(), change.path.clone()))
        .collect();
    let completed = stream::iter(pending)
        .map(|(root, unified, path)| async move {
            untracked(&root, &unified, ignore_whitespace, &path).await
        })
        .buffered(UNTRACKED_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    completed.into_iter().collect()
}

/* 未跟踪文件没有基线，与空文件比。--no-index 蕴含 --exit-code：1 是「有差异」。 */
async fn untracked(
    root: &Path,
    unified: &str,
    ignore_whitespace: bool,
    path: &str,
) -> Result<String, GitError> {
    let mut args = diff_args(&["--no-index"], unified, ignore_whitespace);
    args.extend(["--", "/dev/null", path]);
    let output = run(root, &args).await?;
    if output.status.code().unwrap_or_default() > 1 {
        return expect_ok(output).map(|_| String::new());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

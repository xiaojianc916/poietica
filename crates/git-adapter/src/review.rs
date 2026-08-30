//! 工作树此刻相对某个基准的审查面：一次问答交回分支、清单与整份补丁。
//!
//! 清单走 `git status --porcelain=v2 -z --branch`：v2 是 git 给机器读者定的稳定格式，
//! 分支表头在同一次里带回 head、upstream 与 ahead/behind。补丁走一条 git diff，
//! 加减行数由补丁自己数出 —— 徽章与画面同源，不存在第二个数法。
//! porcelain 记录的解释在 crates/review 的纯解码里，这里只跑命令、拼快照。

use std::path::Path;

use poietica_review_native::{
    ChangeStatus, CommitIntent, FileChange, ReviewSnapshot, parse_entry, read_header,
};

use crate::{GitError, expect_ok, inside_work_tree, local_branches, run};

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
            None => held.changes.extend(parse_entry(record)),
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
        .filter_map(parse_entry)
        .collect();
    patch(root, base, WHOLE, ignore_whitespace, &changes, Some(path)).await
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

/* 只挡把参数读成命令行开关的那一类注入；其余交给 git 自己解释。 */
fn checked(kind: &str, value: &str) -> Result<(), GitError> {
    if value.trim().is_empty() || value.starts_with('-') {
        return Err(GitError::Refused(format!("无效的{kind}：{value}")));
    }
    Ok(())
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

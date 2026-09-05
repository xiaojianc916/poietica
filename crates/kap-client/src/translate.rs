//! 运行时帧 → 会话领域事件的翻译。
//!
//! 帧的成形（frame.rs 的 RunFrame）是这台机器对一轮的判断；翻译把它们落到
//! 领域的封闭联合上，账本从此只认联合。kap 的语义事件不在这条路上过账：
//! 屏幕经过改走官方 transcript 通道（router.rs 的 SessionEvent::Transcript），
//! 这里只翻译协议不建模、而客户端必须记住的事实。

use poietica_conversation::event::ConversationEvent;
use poietica_conversation::identity::TurnId;

use crate::frame::RunFrame;

/// 一帧运行时事实 → 一条领域事件。字段名与载荷原样搬运：翻译不改写事实，
/// 只换词汇表。
#[must_use]
pub fn conversation_event(frame: RunFrame) -> ConversationEvent {
    match frame {
        RunFrame::PromptAdmitted {
            admission_id,
            prompt,
            images,
            skills,
        } => ConversationEvent::PromptAdmitted {
            admission_id: TurnId::new(admission_id),
            prompt: Some(prompt),
            images: Some(images),
            skills: Some(skills),
        },
        RunFrame::PermissionRequested {
            request_id,
            tool_call_id,
            title,
            tool_call,
        } => ConversationEvent::PermissionRequested {
            request_id,
            tool_call_id: Some(tool_call_id),
            title,
            tool_call,
        },
        RunFrame::PermissionResolved {
            request_id,
            decision,
            scope,
            selected_label,
            feedback,
        } => ConversationEvent::PermissionResolved {
            request_id,
            decision,
            scope,
            selected_label,
            feedback,
        },
        RunFrame::QuestionsAsked {
            question_id,
            tool_call_id,
            questions,
        } => ConversationEvent::QuestionsAsked {
            question_id,
            tool_call_id: Some(tool_call_id),
            questions,
        },
        RunFrame::QuestionsResolved {
            question_id,
            outcome,
            answers,
            note,
        } => ConversationEvent::QuestionsResolved {
            question_id,
            outcome,
            answers,
            note,
        },
        RunFrame::SessionRecovered { snapshot } => ConversationEvent::SessionRecovered { snapshot },
        RunFrame::LinkChanged { link } => ConversationEvent::LinkChanged { link },
        RunFrame::RunFinished { stop_reason } => ConversationEvent::RunFinished {
            turn: None,
            stop_reason,
        },
        RunFrame::RunFailed { message } => ConversationEvent::RunFailed {
            turn: None,
            message,
        },
    }
}

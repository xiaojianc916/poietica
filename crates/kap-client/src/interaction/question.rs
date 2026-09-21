//! 契约来源：kap-server 的 protocol/question.ts 与 routes/questions.ts；题号与选项号
//! 由 server 现编，这一侧不解析、原样往返。

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::KapError;
use crate::error::Result;

const UNKNOWN_ITEM: &str = "that question is not part of this group";
const UNANSWERED_ITEM: &str = "every question in this group needs an answer";
const UNKNOWN_OPTION: &str = "that option was never offered for this question";
const ONE_OPTION_ONLY: &str = "that question takes a single option";
const NO_WRITTEN_ANSWER: &str = "that question does not accept a written answer";
const NO_OPTION_PICKED: &str = "a multiple choice answer needs at least one option";

pub(crate) fn refused(message: &str) -> KapError {
    KapError::Question {
        message: message.to_owned(),
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub id: String,
    pub question: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// 两到四个（questionItemSchema 的 min 2 max 4）。
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    /// routes/questions.ts 的 buildItem 对它无条件置真。
    pub allow_other: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_description: Option<String>,
}

#[derive(Clone, Debug)]
pub struct QuestionGroup {
    /// kap 签发的号（interaction.id）。答复与撤下都认它。
    pub question_id: String,
    pub session_id: String,
    pub turn_id: Option<i64>,
    pub tool_call_id: Option<String>,
    pub items: Vec<QuestionItem>,
    pub created_at: String,
}

/// 五种，与 questionAnswerSchema 的判别联合逐一对应。
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum QuestionAnswer {
    Single {
        option_id: String,
    },
    Multi {
        option_ids: Vec<String>,
    },
    Other {
        text: String,
    },
    /// 选了几个，还自己写了一句；线上允许一个都没选。
    MultiWithOther {
        option_ids: Vec<String>,
        other_text: String,
    },
    Skipped,
}

/// 官方把 click 丢掉（toInProcessResponse 只在 method 不是 click 时才带上它），
/// 但它在 wire 上合法，改报成别的就是撒谎。
#[derive(Clone, Copy, Debug)]
pub enum AnswerMethod {
    Enter,
    Space,
    NumberKey,
    Click,
}

#[derive(Clone, Debug)]
pub struct QuestionResponse {
    pub answers: HashMap<String, QuestionAnswer>,
    pub method: Option<AnswerMethod>,
    /// wire 上合法的一格（questionResponseSchema 的 note），但官方 server 收下之后不读它。
    pub note: Option<String>,
}

#[derive(Clone, Debug)]
pub enum QuestionOutcome {
    Answered(QuestionResponse),
    Dismissed,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AnsweredQuestion {
    question_id: String,
    answer: QuestionAnswer,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn picked(option_ids: &[String]) -> Value {
    Value::from(option_ids.to_vec())
}

impl QuestionOption {
    fn from_wire(value: &Value) -> Option<Self> {
        Some(Self {
            id: text(value, "id")?,
            label: text(value, "label")?,
            description: text(value, "description"),
        })
    }
}

impl QuestionItem {
    fn from_wire(value: &Value) -> Option<Self> {
        let mut options = Vec::new();

        // 一个读不下来的选项不能被静默丢掉：选项少一个，这一题就是另一道题。
        for offered in value.get("options").and_then(Value::as_array)? {
            options.push(QuestionOption::from_wire(offered)?);
        }

        if options.is_empty() {
            return None;
        }

        Some(Self {
            id: text(value, "id")?,
            question: text(value, "question")?,
            header: text(value, "header"),
            body: text(value, "body"),
            options,
            multi_select: flag(value, "multi_select"),
            allow_other: flag(value, "allow_other"),
            other_label: text(value, "other_label"),
            other_description: text(value, "other_description"),
        })
    }

    /// 比 server 严：官方只按 schema 验形状，不拿题去验答案。
    fn accepts(&self, answer: &QuestionAnswer) -> Result<()> {
        match answer {
            QuestionAnswer::Single { option_id } => self.offers(option_id),

            QuestionAnswer::Multi { option_ids } => {
                if !self.multi_select {
                    return Err(refused(ONE_OPTION_ONLY));
                }

                if option_ids.is_empty() {
                    return Err(refused(NO_OPTION_PICKED));
                }

                self.offers_all(option_ids)
            }

            QuestionAnswer::Other { text: _ } => {
                if self.allow_other {
                    return Ok(());
                }

                Err(refused(NO_WRITTEN_ANSWER))
            }

            QuestionAnswer::MultiWithOther {
                option_ids,
                other_text: _,
            } => {
                if !self.multi_select {
                    return Err(refused(ONE_OPTION_ONLY));
                }

                if !self.allow_other {
                    return Err(refused(NO_WRITTEN_ANSWER));
                }

                self.offers_all(option_ids)
            }

            QuestionAnswer::Skipped => Ok(()),
        }
    }

    fn offers(&self, option_id: &str) -> Result<()> {
        if self.options.iter().any(|option| option.id == option_id) {
            return Ok(());
        }

        Err(refused(UNKNOWN_OPTION))
    }

    fn offers_all(&self, option_ids: &[String]) -> Result<()> {
        for option_id in option_ids {
            self.offers(option_id)?;
        }

        Ok(())
    }
}

impl QuestionAnswer {
    fn on_wire(&self) -> Value {
        let mut body = Map::new();

        match self {
            Self::Single { option_id } => {
                let _kind = body.insert("kind".to_owned(), Value::from("single"));
                let _set = body.insert("option_id".to_owned(), Value::from(option_id.clone()));
            }
            Self::Multi { option_ids } => {
                let _kind = body.insert("kind".to_owned(), Value::from("multi"));
                let _set = body.insert("option_ids".to_owned(), picked(option_ids));
            }
            Self::Other { text } => {
                let _kind = body.insert("kind".to_owned(), Value::from("other"));
                let _set = body.insert("text".to_owned(), Value::from(text.clone()));
            }
            Self::MultiWithOther {
                option_ids,
                other_text,
            } => {
                let _kind = body.insert("kind".to_owned(), Value::from("multi_with_other"));
                let _set = body.insert("option_ids".to_owned(), picked(option_ids));
                let _wrote = body.insert("other_text".to_owned(), Value::from(other_text.clone()));
            }
            Self::Skipped => {
                let _kind = body.insert("kind".to_owned(), Value::from("skipped"));
            }
        }

        Value::Object(body)
    }
}

impl AnswerMethod {
    #[must_use]
    pub const fn on_wire(self) -> &'static str {
        match self {
            Self::Enter => "enter",
            Self::Space => "space",
            Self::NumberKey => "number_key",
            Self::Click => "click",
        }
    }
}

impl QuestionGroup {
    /// 读 kap 的 questionRequestSchema；缺一格整组不认。
    #[must_use]
    pub fn from_wire(value: &Value) -> Option<Self> {
        let mut items = Vec::new();

        for asked in value.get("questions").and_then(Value::as_array)? {
            items.push(QuestionItem::from_wire(asked)?);
        }

        if items.is_empty() {
            return None;
        }

        Some(Self {
            question_id: text(value, "question_id")?,
            session_id: text(value, "session_id")?,
            turn_id: value.get("turn_id").and_then(Value::as_i64),
            tool_call_id: text(value, "tool_call_id"),
            items,
            created_at: text(value, "created_at")?,
        })
    }

    #[must_use]
    pub fn item(&self, question_id: &str) -> Option<&QuestionItem> {
        self.items.iter().find(|item| item.id == question_id)
    }

    /// 序列化失败退回空数组而不是 panic：一组题显示不出来是缺陷，把整条连接打死是事故。
    #[must_use]
    pub fn on_frame(&self) -> Value {
        serde_json::to_value(&self.items).unwrap_or_else(|_impossible| Value::Array(Vec::new()))
    }
}

impl QuestionResponse {
    pub fn checked_against(&self, group: &QuestionGroup) -> Result<()> {
        for (question_id, answer) in &self.answers {
            let Some(item) = group.item(question_id) else {
                return Err(refused(UNKNOWN_ITEM));
            };

            item.accepts(answer)?;
        }

        // 一次答齐是这一侧的规矩，不是协议的要求（官方对缺答的题不作声）；
        // 界面整组一起收，少一题只可能是漏发。
        if group
            .items
            .iter()
            .any(|item| !self.answers.contains_key(&item.id))
        {
            return Err(refused(UNANSWERED_ITEM));
        }

        Ok(())
    }

    #[must_use]
    pub fn on_wire(&self) -> Value {
        let mut answers = Map::new();

        for (question_id, answer) in &self.answers {
            let _wrote = answers.insert(question_id.clone(), answer.on_wire());
        }

        let mut body = Map::new();
        let _set = body.insert("answers".to_owned(), Value::Object(answers));

        if let Some(method) = self.method {
            let _set = body.insert("method".to_owned(), Value::from(method.on_wire()));
        }

        if let Some(note) = &self.note {
            let _set = body.insert("note".to_owned(), Value::from(note.clone()));
        }

        Value::Object(body)
    }

    #[must_use]
    pub fn on_frame(&self, group: &QuestionGroup) -> Value {
        let answered: Vec<AnsweredQuestion> = group
            .items
            .iter()
            .filter_map(|item| {
                self.answers.get(&item.id).map(|answer| AnsweredQuestion {
                    question_id: item.id.clone(),
                    answer: answer.clone(),
                })
            })
            .collect();

        serde_json::to_value(&answered).unwrap_or_else(|_impossible| Value::Array(Vec::new()))
    }
}

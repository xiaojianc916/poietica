//! 官方 kap 的提问域：一组题、一组答复，以及答复合不合这组题。
//!
//! 契约事实来源是 kap-server 的 protocol/question.ts 与 routes/questions.ts。
//! 三件事决定了这个模块的形状。
//!
//! 号是 server 现编的。题号 q_{i} 与选项号 opt_{i}_{j} 在每一次列举待答提问时
//! 由 buildItem / buildOption 生成，所以这一侧不解析号、不重排号、也不从号里读
//! 语义 —— 号原样往返。
//!
//! 一题的合法答复取决于它自己。multi_select 决定能不能多选，allow_other 决定能
//! 不能写字，所以校验必须按题做，不能按组做。
//!
//! 线上与屏幕是两种渲染。wire 要 snake_case（option_id / other_text），帧要
//! camelCase（界面读的那一份）。同一个类型两种渲染，各只有一处：derive 管帧，
//! on_wire 管线上。

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

/// 一个说不通的答复。这一层唯一的拒绝理由，措辞留给发现它的那一处。
pub(crate) fn refused(message: &str) -> KapError {
    KapError::Question {
        message: message.to_owned(),
    }
}

/// 一题里的一个选项。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    /// server 现编的号，原样交回去。
    pub id: String,
    pub label: String,
    /// 这个选项自己的一句解释，agent 给了才有。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 一道题。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub id: String,
    pub question: String,
    /// 题面之上的一行标题。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub header: Option<String>,
    /// 题面之下的正文。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body: Option<String>,
    /// 两到四个（questionItemSchema 的 min 2 max 4）。
    pub options: Vec<QuestionOption>,
    /// 这一题能不能多选。
    pub multi_select: bool,
    /// 这一题能不能自己写一句。routes/questions.ts 的 buildItem 对它无条件置真。
    pub allow_other: bool,
    /// 「其他」那一栏怎么称呼。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_label: Option<String>,
    /// 「其他」那一栏的说明。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub other_description: Option<String>,
}

/// 一次提问：最多四题，一起问也一起答。
#[derive(Clone, Debug)]
pub struct QuestionGroup {
    /// kap 签发的号（interaction.id）。答复与撤下都认它。
    pub question_id: String,
    pub session_id: String,
    /// 第几轮。线上是个整数，不是字符串。
    pub turn_id: Option<i64>,
    /// 引出这一组题的那次工具调用；kap 说它可以缺席。
    pub tool_call_id: Option<String>,
    pub items: Vec<QuestionItem>,
    pub created_at: String,
}

/// 一题答的是什么，五种，与 questionAnswerSchema 的判别联合逐一对应。
///
/// 判别式在线上叫 kind。
#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum QuestionAnswer {
    /// 选了一个。
    Single { option_id: String },
    /// 选了几个。
    Multi { option_ids: Vec<String> },
    /// 一个都没选，自己写了一句。
    Other { text: String },
    /// 选了几个，还自己写了一句。线上允许一个都没选。
    MultiWithOther {
        option_ids: Vec<String>,
        other_text: String,
    },
    /// 这一题跳过。
    Skipped,
}

/// 人是怎么答的。
///
/// 如实上报：官方把 click 丢掉（toInProcessResponse 只在 method 不是 click 时才
/// 带上它），但它在 wire 上是合法值，改报成别的就是撒谎。
#[derive(Clone, Copy, Debug)]
pub enum AnswerMethod {
    Enter,
    Space,
    NumberKey,
    Click,
}

/// 一整组的答复。
#[derive(Clone, Debug)]
pub struct QuestionResponse {
    /// 逐题一条，键是题号。
    pub answers: HashMap<String, QuestionAnswer>,
    pub method: Option<AnswerMethod>,
    /// 整组的备注。
    ///
    /// wire 上它是合法的一格（questionResponseSchema 的 note），但官方 server 收
    /// 下之后不读它：toInProcessResponse 只把 answers 与 method 交给
    /// ISessionQuestionService。送它是因为契约里有它，不是因为它今天有效果。
    pub note: Option<String>,
}

/// 一组题最终怎么收场。
#[derive(Clone, Debug)]
pub enum QuestionOutcome {
    /// 人答了。
    Answered(QuestionResponse),
    /// 人把这一组撤下了，一题都不答。
    Dismissed,
}

/// 帧上逐题的那一条：一张 map 在帧里排不出顺序，而界面要按问的顺序显示。
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
    Value::Array(
        option_ids
            .iter()
            .map(|id| Value::String(id.clone()))
            .collect(),
    )
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

    /// 这一题收不收这个答复。
    ///
    /// 比 server 严：官方只按 schema 验形状，不拿题去验答案。这一侧要严，因为
    /// 界面产不出来的答复就不该发得出去 —— 一个只能在对面被发现的错误，等于没
    /// 有被发现。
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
    /// 线上那一份（snake_case）。
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
    /// 线上那个词（questionAnswerMethodSchema）。
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
    /// 读 kap 的 questionRequestSchema。
    ///
    /// 缺一格就整组不认：一组半懂的题问不出去，而一个猜出来的题号会让答复落到
    /// 别的题上。
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

    /// 这一组里的那一题。
    #[must_use]
    pub fn item(&self, question_id: &str) -> Option<&QuestionItem> {
        self.items.iter().find(|item| item.id == question_id)
    }

    /// 帧上那一份题目（camelCase，界面读的那一份）。
    ///
    /// 序列化失败退回空数组而不是 panic：这里只有字符串、布尔与数组，没有非字符
    /// 串的键，也没有手写的 Serialize，所以那一支到不了；而即便到了，一组题显示
    /// 不出来是缺陷，把整条连接打死是事故。
    #[must_use]
    pub fn on_frame(&self) -> Value {
        serde_json::to_value(&self.items).unwrap_or_else(|_impossible| Value::Array(Vec::new()))
    }
}

impl QuestionResponse {
    /// 这一组答复对不对得上这一组题。
    ///
    /// # Errors
    ///
    /// 题号不在这一组、有题没答、选项没提供过、多选答给了单选题、写的字给了不收
    /// 字的题，或多选一个都没选。
    pub fn checked_against(&self, group: &QuestionGroup) -> Result<()> {
        for (question_id, answer) in &self.answers {
            let Some(item) = group.item(question_id) else {
                return Err(refused(UNKNOWN_ITEM));
            };

            item.accepts(answer)?;
        }

        // 一组题一次答齐，是这一侧的规矩，不是协议的要求：官方对缺答的题不作声。
        // 这一侧要求答齐，因为界面就是整组一起收的 —— 少一题只可能是漏发。
        if group
            .items
            .iter()
            .any(|item| !self.answers.contains_key(&item.id))
        {
            return Err(refused(UNANSWERED_ITEM));
        }

        Ok(())
    }

    /// 按 questionResolveRequestSchema 做成请求体。
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

    /// 帧上那一份答复，按问的顺序。
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

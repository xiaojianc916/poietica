//! 产品的一组题与一条答复。
//!
//! 形状来源是 packages/agent-bridge/src/protocol.ts 的 AskedQuestion —— 桥把 agent
//! 自己的载荷折成产品形状再报上来，本层不认识任何一家的字段名（AGENTS.md §4）。
//!
//! 题号与选项号都由桥签发：这一侧只按号对账（题上的 `id` 决定答复挂在哪一格，
//! 选项上的 `id` 决定人选了哪一枚），既不解析也不重新推导。

use std::collections::HashMap;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error::AgentError;
use crate::error::Result;

/// 题组来自哪件工具。omp 的 ask 载荷里没有调用号，这个字面量与
/// packages/agent-bridge/src/main.ts 的 openQuestion 同值（那边也写 'ask'）。
const ASK_TOOL: &str = "ask";

const UNKNOWN_ITEM: &str = "that question is not part of this group";
const UNANSWERED_ITEM: &str = "every question in this group needs an answer";
const UNKNOWN_OPTION: &str = "that option was never offered for this question";
const ONE_OPTION_ONLY: &str = "that question takes a single option";
const NO_WRITTEN_ANSWER: &str = "that question does not accept a written answer";
const NO_OPTION_PICKED: &str = "a multiple choice answer needs at least one option";

pub(crate) fn refused(message: &str) -> AgentError {
    AgentError::Question {
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
    /// 题给的候选；可以是空的 —— 人自己写一句就是答案（`allow_other`）。
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
    /// 上游恒定允许自答：packages/agent-bridge/src/protocol.ts 的 AskedQuestion
    /// 对它恒置真（omp 的 ask 恒定带 OTHER_OPTION）。
    pub allow_other: bool,
}

#[derive(Clone, Debug)]
pub struct QuestionGroup {
    /// 这一次提问的号：上游那次对话框的 requestId。答复挂同一个号回去 ——
    /// 换一个号，桥就认不出是谁在等（它的 desk.settle 会如实报没有）。
    pub question_id: String,
    pub session_id: String,
    pub tool_call_id: Option<String>,
    pub items: Vec<QuestionItem>,
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
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AnswerMethod {
    Enter,
    Space,
    NumberKey,
    Click,
}

/// 一条答复：按题号逐题答，加上人是**怎么**答的。
///
/// 这一侧序列化出去就是桥要读的那份载荷（protocol.ts 的 answers 一格）：
/// `answers` 以题号为键，`method` 与 `note` 可缺席。
#[derive(Clone, Debug, Serialize)]
pub struct QuestionResponse {
    pub answers: HashMap<String, QuestionAnswer>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<AnswerMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

impl QuestionResponse {
    /// 撤下整组：一条答复都没有。桥按「answers 空」判作没答，上游把没答读成取消
    /// （tools/ask.ts:946-949 的 `if (!richResult)`），那正是撤下该有的结局。
    #[must_use]
    pub fn dismissed() -> Self {
        Self {
            answers: HashMap::new(),
            method: None,
            note: None,
        }
    }
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
    /// 读 protocol.ts 的 AskedQuestion（camelCase，与 packages/conversation 的
    /// QuestionItem 同形）。
    ///
    /// 一个选项读不下来就整题作废，不跳过它：选项少一枚，这一题就是另一道题，
    /// 而答复会按错的题面回给模型。题一枚选项都没有是合法的（人自己写答案）。
    fn from_wire(value: &Value) -> Option<Self> {
        let mut options = Vec::new();

        for offered in value.get("options").and_then(Value::as_array)? {
            options.push(QuestionOption::from_wire(offered)?);
        }

        Some(Self {
            id: text(value, "id")?,
            question: text(value, "question")?,
            header: text(value, "header"),
            options,
            multi_select: flag(value, "multiSelect"),
            allow_other: flag(value, "allowOther"),
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

impl QuestionGroup {
    /// 桥报的一组题（protocol.ts 的 `questions_asked`）→ 产品的一组题。
    ///
    /// 号与会话号在事件信封上，不在 questions 里：题组身份由报的人签发，这一侧不编。
    /// 一组里只要有一道题读不下来就整组不认 —— 画半组题会让人答一道不完整的题，
    /// 而答复要求一次答齐（见 `checked_against`）。
    #[must_use]
    pub fn from_questions(session_id: &str, request_id: &str, questions: &Value) -> Option<Self> {
        let mut items = Vec::new();

        for asked in questions.as_array()? {
            items.push(QuestionItem::from_wire(asked)?);
        }

        if items.is_empty() {
            return None;
        }

        Some(Self {
            question_id: request_id.to_owned(),
            session_id: session_id.to_owned(),
            /* 题组只来自 ask 工具：omp 的载荷里没有工具调用号，模型也调不出第二个来源。 */
            tool_call_id: Some(ASK_TOOL.to_owned()),
            items,
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

    /// 交给桥的那份载荷：`{answers: {题号: 答复}, method?, note?}`。
    ///
    /// 就是 serde 派生的那个形状 —— 桥按同一份读（packages/agent-bridge/src/
    /// questions.ts 的 answerPayloadOf），所以这里不再手写第二份。
    #[must_use]
    pub fn on_wire(&self) -> Value {
        serde_json::to_value(self).unwrap_or_else(|_impossible| Value::Object(Map::new()))
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

#[cfg(test)]
mod tests {
    #![allow(
        clippy::expect_used,
        clippy::indexing_slicing,
        reason = "a test proves itself by panicking, and these fixtures are known-good"
    )]

    use serde_json::json;

    use super::{AnswerMethod, QuestionAnswer, QuestionGroup, QuestionResponse};

    const QUESTIONS: &str = r#"[{"id":"q0","question":"哪种配色？","header":"配色","options":[{"id":"o0","label":"深色"},{"id":"o1","label":"浅色"}],"multiSelect":false,"allowOther":true}]"#;

    /// 一条答复被拒的理由：拒在哪一条规则上。
    fn refusal(response: &QuestionResponse, group: &QuestionGroup) -> String {
        let crate::error::AgentError::Question { message } = response
            .checked_against(group)
            .expect_err("this answer is meant to be refused")
        else {
            unreachable!("only a question refusal is possible here");
        };

        message
    }

    fn group() -> QuestionGroup {
        QuestionGroup::from_questions(
            "sess_1",
            "d7",
            &serde_json::from_str(QUESTIONS).expect("the fixture is JSON"),
        )
        .expect("the product shape must parse")
    }

    #[test]
    fn the_group_takes_its_identity_from_the_event_not_from_the_payload() {
        let parsed = group();

        assert_eq!(parsed.question_id, "d7", "答复挂桥签发的那个号回去");
        assert_eq!(parsed.session_id, "sess_1");
        assert_eq!(parsed.tool_call_id.as_deref(), Some("ask"));
        assert_eq!(parsed.items.len(), 1);
        assert_eq!(parsed.items[0].id, "q0");
        assert!(!parsed.items[0].multi_select, "读的是产品那个 camelCase 键");
        assert!(parsed.items[0].allow_other);
        assert_eq!(
            parsed.items[0].header.as_deref(),
            Some("配色"),
            "题上方的短标签随题带来"
        );
    }

    /// 题面读不齐全就整组不认：半组题的答复会按错的题面回给模型。
    #[test]
    fn a_group_with_one_unreadable_question_is_refused_whole() {
        assert!(
            QuestionGroup::from_questions(
                "s",
                "d1",
                &json!([
                    { "id": "q0", "question": "好题", "options": [{ "id": "o0", "label": "有" }] },
                    { "id": "q1", "question": "缺选项标签", "options": [{ "id": "o9" }] }
                ])
            )
            .is_none()
        );

        assert!(QuestionGroup::from_questions("s", "d1", &json!([])).is_none());
    }

    /// 题上一枚选项都没有是合法的：人自己写一句就是答案（allowOther）。
    #[test]
    fn a_question_may_offer_no_options_at_all() {
        let parsed = QuestionGroup::from_questions(
            "s",
            "d1",
            &json!([{ "id": "q0", "question": "说吧", "options": [], "multiSelect": false, "allowOther": true }]),
        )
        .expect("an optionless question with a written answer must parse");

        assert!(parsed.items[0].options.is_empty());
    }

    /// 答复按题号对账：不是这一组的题、没答齐、选项不是题给的，都拒。
    #[test]
    fn an_answer_is_checked_against_the_questions_it_names() {
        let parsed = group();

        let accepts = |answer: QuestionAnswer| QuestionResponse {
            answers: [("q0".to_owned(), answer)].into_iter().collect(),
            method: None,
            note: None,
        };

        assert!(
            accepts(QuestionAnswer::Single {
                option_id: "o1".to_owned()
            })
            .checked_against(&parsed)
            .is_ok()
        );

        /* 题给的选项只有 o0 / o1。 */
        assert_eq!(
            refusal(
                &accepts(QuestionAnswer::Single {
                    option_id: "o9".to_owned()
                }),
                &parsed
            ),
            super::UNKNOWN_OPTION
        );

        /* 这一题是单选。 */
        assert_eq!(
            refusal(
                &accepts(QuestionAnswer::Multi {
                    option_ids: vec!["o0".to_owned(), "o1".to_owned()]
                }),
                &parsed
            ),
            super::ONE_OPTION_ONLY
        );

        /* 整组一次答齐：只答一题、另一题缺席。 */
        let short = QuestionGroup::from_questions(
            "s",
            "d1",
            &json!([
                { "id": "q0", "question": "一", "options": [{ "id": "o0", "label": "a" }], "multiSelect": false, "allowOther": false },
                { "id": "q1", "question": "二", "options": [{ "id": "o0", "label": "b" }], "multiSelect": false, "allowOther": false }
            ]),
        )
        .expect("two readable questions");

        assert_eq!(
            refusal(
                &accepts(QuestionAnswer::Single {
                    option_id: "o0".to_owned()
                }),
                &short
            ),
            super::UNANSWERED_ITEM
        );

        /* 答的是一道这一组里没有的题。 */
        let stray = QuestionResponse {
            answers: [(
                "q9".to_owned(),
                QuestionAnswer::Single {
                    option_id: "o0".to_owned(),
                },
            )]
            .into_iter()
            .collect(),
            method: None,
            note: None,
        };

        assert_eq!(refusal(&stray, &parsed), super::UNKNOWN_ITEM);
    }

    /// 界面上够得到的每一条答复都答得出去（question-answer.ts 的 answerOf）。
    ///
    /// 面板对空多选给不出答复（它落成 other 或 undefined），所以 `Multi` 空表在这里
    /// 够不到；留着那道闸是防着别的调用方送来一条上游读不懂的答复。
    #[test]
    fn every_answer_the_panel_can_send_is_accepted() {
        let multi = QuestionGroup::from_questions(
            "s",
            "d1",
            &json!([{ "id": "q0", "question": "多选", "options": [{ "id": "o0", "label": "a" }], "multiSelect": true, "allowOther": true }]),
        )
        .expect("a multi question");

        for answer in [
            QuestionAnswer::Multi {
                option_ids: vec!["o0".to_owned()],
            },
            QuestionAnswer::MultiWithOther {
                option_ids: vec!["o0".to_owned()],
                other_text: "还有别的".to_owned(),
            },
            QuestionAnswer::Other {
                text: "自己写".to_owned(),
            },
            QuestionAnswer::Skipped,
        ] {
            let response = QuestionResponse {
                answers: [("q0".to_owned(), answer.clone())].into_iter().collect(),
                method: Some(AnswerMethod::Click),
                note: None,
            };

            assert!(
                response.checked_against(&multi).is_ok(),
                "{answer:?} must be answerable"
            );
        }
    }

    /// 送上桥的那份载荷：键是题号、判别式与字段就是产品那几个词。
    #[test]
    fn the_answer_goes_on_the_wire_in_the_shape_the_bridge_reads() {
        let response = QuestionResponse {
            answers: [(
                "q0".to_owned(),
                QuestionAnswer::Single {
                    option_id: "o1".to_owned(),
                },
            )]
            .into_iter()
            .collect(),
            method: Some(AnswerMethod::NumberKey),
            note: Some("就它".to_owned()),
        };

        assert_eq!(
            response.on_wire(),
            json!({
                "answers": { "q0": { "kind": "single", "optionId": "o1" } },
                "method": "number_key",
                "note": "就它"
            })
        );

        /* 撤下整组：一条答复都没有，桥据此判作没答。 */
        assert_eq!(
            QuestionResponse::dismissed().on_wire(),
            json!({ "answers": {} })
        );
    }
}

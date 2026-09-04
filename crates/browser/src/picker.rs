use url::Url;

const ELEMENT_TYPE_LIMIT: usize = 64;
const COMMENT_LIMIT: usize = 2_000;
/// 快照经查询串回来，上界只为挡住失控的页面，不是内容策略。
const REPORT_LIMIT: usize = 64_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PickerLease {
    tab_id: u32,
    token: u64,
}

impl PickerLease {
    #[must_use]
    pub fn tab_id(self) -> u32 {
        self.tab_id
    }

    #[must_use]
    pub fn token(self) -> u64 {
        self.token
    }
}

#[derive(Debug, Default)]
pub struct Picker {
    active: Option<PickerLease>,
    next_token: u64,
}

impl Picker {
    #[must_use]
    pub fn active_tab_id(&self) -> Option<u32> {
        self.active.map(PickerLease::tab_id)
    }

    pub fn start(&mut self, tab_id: u32) -> PickerLease {
        self.next_token = self.next_token.checked_add(1).unwrap_or(1);
        let lease = PickerLease {
            tab_id,
            token: self.next_token,
        };
        self.active = Some(lease);
        lease
    }

    pub fn cancel(&mut self, tab_id: u32) -> Option<PickerLease> {
        if self.active_tab_id() == Some(tab_id) {
            self.active.take()
        } else {
            None
        }
    }

    pub fn cancel_active(&mut self) -> Option<PickerLease> {
        self.active.take()
    }

    pub fn finish(&mut self, tab_id: u32, token: u64) -> bool {
        if self.active == Some(PickerLease { tab_id, token }) {
            self.active = None;
            true
        } else {
            false
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PickSubmission {
    Attach,
    Send,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PickedElement {
    pub element_type: String,
    pub comment: String,
    pub report: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PickOutcome {
    Cancelled {
        token: u64,
    },
    Submitted {
        token: u64,
        submission: PickSubmission,
        element: PickedElement,
    },
}

impl PickOutcome {
    #[must_use]
    pub fn token(&self) -> u64 {
        match self {
            Self::Cancelled { token } | Self::Submitted { token, .. } => *token,
        }
    }
}

#[must_use]
pub fn is_picker_callback(target: &Url) -> bool {
    target.scheme() == "https"
        && target.host_str() == Some("pick.poietica.invalid")
        && target.path() == "/"
}

fn clamp(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

/// 标签只进输入框 chip；压成单行并限制长度。
fn one_line(value: &str, limit: usize) -> String {
    clamp(
        &value.split_whitespace().collect::<Vec<_>>().join(" "),
        limit,
    )
}

#[must_use]
pub fn decode_picker_callback(target: &Url) -> Option<PickOutcome> {
    if !is_picker_callback(target) {
        return None;
    }

    let mut token = None;
    let mut submission = None;
    let mut element_type = String::new();
    let mut comment = String::new();
    let mut report = String::new();

    for (key, value) in target.query_pairs() {
        match key.as_ref() {
            "token" => token = value.parse::<u64>().ok(),
            "submission" => submission = Some(value.into_owned()),
            "elementType" => element_type = one_line(&value, ELEMENT_TYPE_LIMIT),
            "comment" => comment = clamp(&value, COMMENT_LIMIT),
            "report" => report = clamp(&value, REPORT_LIMIT),
            _ => {}
        }
    }

    let token = token?;
    match submission?.as_str() {
        "cancel" => Some(PickOutcome::Cancelled { token }),
        value @ ("attach" | "send") => {
            if element_type.is_empty() || report.is_empty() {
                return None;
            }

            Some(PickOutcome::Submitted {
                token,
                submission: if value == "send" {
                    PickSubmission::Send
                } else {
                    PickSubmission::Attach
                },
                element: PickedElement {
                    element_type,
                    comment,
                    report,
                },
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "test fixtures must be constructible")]

    use super::*;

    fn callback(pairs: &[(&str, &str)]) -> Url {
        let mut url = Url::parse("https://pick.poietica.invalid/").expect("valid callback");
        url.query_pairs_mut().extend_pairs(pairs);
        url
    }

    #[test]
    fn stale_and_cross_tab_leases_are_rejected() {
        let mut picker = Picker::default();
        let first = picker.start(7);
        let second = picker.start(7);
        assert!(!picker.finish(7, first.token()));
        assert!(!picker.finish(8, second.token()));
        assert!(picker.finish(7, second.token()));
    }

    #[test]
    fn a_submission_carries_the_whole_report() {
        let outcome = decode_picker_callback(&callback(&[
            ("token", "9"),
            ("submission", "send"),
            ("elementType", "button"),
            ("report", "# 样式与布局\n字号 (font-size): 16px"),
        ]))
        .expect("valid payload");

        assert!(matches!(
            outcome,
            PickOutcome::Submitted {
                submission: PickSubmission::Send,
                ref element,
                ..
            } if element.report.contains("font-size")
        ));
    }

    #[test]
    fn an_element_type_is_a_bounded_single_line_label() {
        let outcome = decode_picker_callback(&callback(&[
            ("token", "1"),
            ("submission", "attach"),
            ("elementType", "a\nignored"),
            ("report", "x"),
        ]))
        .expect("valid payload");

        assert!(matches!(
            outcome,
            PickOutcome::Submitted { ref element, .. }
                if element.element_type == "a ignored"
        ));
    }

    #[test]
    fn a_submission_without_a_report_is_refused() {
        assert!(
            decode_picker_callback(&callback(&[
                ("token", "1"),
                ("submission", "send"),
                ("elementType", "button"),
            ]))
            .is_none()
        );
        assert!(!is_picker_callback(
            &Url::parse("https://example.com/").expect("valid url")
        ));
    }
}

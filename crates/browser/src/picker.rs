use url::Url;

const URL_LIMIT: usize = 2_000;
const TITLE_LIMIT: usize = 300;
const SELECTOR_LIMIT: usize = 2_000;
const TEXT_LIMIT: usize = 2_000;
const CONTEXT_LIMIT: usize = 4_000;
const COMMENT_LIMIT: usize = 2_000;

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
    pub url: String,
    pub title: String,
    pub tag_name: String,
    pub selector: String,
    pub role: String,
    pub accessible_name: String,
    pub text: String,
    pub html: String,
    pub styles: String,
    pub comment: String,
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

#[must_use]
pub fn decode_picker_callback(target: &Url) -> Option<PickOutcome> {
    if !is_picker_callback(target) {
        return None;
    }

    let mut token = None;
    let mut submission = None;
    let mut url = String::new();
    let mut title = String::new();
    let mut tag_name = String::new();
    let mut selector = String::new();
    let mut role = String::new();
    let mut accessible_name = String::new();
    let mut text = String::new();
    let mut html = String::new();
    let mut styles = String::new();
    let mut comment = String::new();

    for (key, value) in target.query_pairs() {
        match key.as_ref() {
            "token" => token = value.parse::<u64>().ok(),
            "submission" => submission = Some(value.into_owned()),
            "url" => url = clamp(&value, URL_LIMIT),
            "title" => title = clamp(&value, TITLE_LIMIT),
            "tag" => tag_name = clamp(&value, 64),
            "selector" => selector = clamp(&value, SELECTOR_LIMIT),
            "role" => role = clamp(&value, 128),
            "name" => accessible_name = clamp(&value, 1_000),
            "text" => text = clamp(&value, TEXT_LIMIT),
            "html" => html = clamp(&value, CONTEXT_LIMIT),
            "styles" => styles = clamp(&value, CONTEXT_LIMIT),
            "comment" => comment = clamp(&value, COMMENT_LIMIT),
            _ => {}
        }
    }

    let token = token?;
    match submission?.as_str() {
        "cancel" => Some(PickOutcome::Cancelled { token }),
        value @ ("attach" | "send") => {
            let page = Url::parse(&url).ok()?;
            if !matches!(page.scheme(), "http" | "https") || selector.is_empty() {
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
                    url,
                    title,
                    tag_name,
                    selector,
                    role,
                    accessible_name,
                    text,
                    html,
                    styles,
                    comment,
                },
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used, reason = "测试输入必须能构造")]
    use super::*;

    fn callback(query: &str) -> Url {
        Url::parse(&("https://pick.poietica.invalid/?".to_owned() + query)).expect("valid callback")
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
    fn callback_is_discriminated_and_bounded() {
        let outcome = decode_picker_callback(&callback(
            "token=9&submission=send&url=https%3A%2F%2Fexample.com%2F&selector=%23save&tag=button&html=%3Cbutton%3ESave%3C%2Fbutton%3E",
        )).expect("valid payload");
        assert!(matches!(
            outcome,
            PickOutcome::Submitted {
                submission: PickSubmission::Send,
                ..
            }
        ));
    }

    #[test]
    fn malformed_and_non_callback_urls_are_refused() {
        assert!(decode_picker_callback(&callback("token=1&submission=send")).is_none());
        assert!(!is_picker_callback(
            &Url::parse("https://example.com/").expect("valid url")
        ));
    }
}

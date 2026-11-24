//! Key events as sent from JS, converted to crossterm events.

use crossterm::event::{Event, KeyEvent};
use reedline::{KeyCode, KeyModifiers, ReedlineRawEvent};

/// A key as described by the TS side.
///
/// `code` is one of: `char`, `enter`, `tab`, `backtab`, `backspace`, `esc`,
/// `left`, `right`, `up`, `down`, `home`, `end`, `pageup`, `pagedown`,
/// `delete`, `insert`, `f1`..`f12`. `ch` carries the character for `char`.
#[cfg_attr(feature = "napi-bindings", napi_derive::napi(object))]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Key {
    pub code: String,
    pub ch: Option<String>,
    pub ctrl: Option<bool>,
    pub alt: Option<bool>,
    pub shift: Option<bool>,
}

impl Key {
    pub fn char(c: char) -> Self {
        Self { code: "char".into(), ch: Some(c.to_string()), ..Default::default() }
    }

    pub fn named(code: &str) -> Self {
        Self { code: code.into(), ..Default::default() }
    }

    pub fn ctrl(mut self) -> Self {
        self.ctrl = Some(true);
        self
    }

    pub fn shift(mut self) -> Self {
        self.shift = Some(true);
        self
    }

    pub fn alt(mut self) -> Self {
        self.alt = Some(true);
        self
    }

    pub fn modifiers(&self) -> KeyModifiers {
        let mut m = KeyModifiers::NONE;
        if self.ctrl.unwrap_or(false) {
            m |= KeyModifiers::CONTROL;
        }
        if self.alt.unwrap_or(false) {
            m |= KeyModifiers::ALT;
        }
        if self.shift.unwrap_or(false) {
            m |= KeyModifiers::SHIFT;
        }
        m
    }

    pub fn key_code(&self) -> Option<KeyCode> {
        Some(match self.code.as_str() {
            "char" => KeyCode::Char(self.ch.as_deref()?.chars().next()?),
            "enter" => KeyCode::Enter,
            "tab" => KeyCode::Tab,
            "backtab" => KeyCode::BackTab,
            "backspace" => KeyCode::Backspace,
            "esc" => KeyCode::Esc,
            "left" => KeyCode::Left,
            "right" => KeyCode::Right,
            "up" => KeyCode::Up,
            "down" => KeyCode::Down,
            "home" => KeyCode::Home,
            "end" => KeyCode::End,
            "pageup" => KeyCode::PageUp,
            "pagedown" => KeyCode::PageDown,
            "delete" => KeyCode::Delete,
            "insert" => KeyCode::Insert,
            f if f.starts_with('f') => KeyCode::F(f[1..].parse().ok()?),
            _ => return None,
        })
    }

    pub(crate) fn from_event(event: KeyEvent) -> Option<Self> {
        let mut key = match event.code {
            KeyCode::Char(c) => Self::char(c),
            KeyCode::Enter => Self::named("enter"),
            KeyCode::Tab => Self::named("tab"),
            KeyCode::BackTab => Self::named("backtab"),
            KeyCode::Backspace => Self::named("backspace"),
            KeyCode::Esc => Self::named("esc"),
            KeyCode::Left => Self::named("left"),
            KeyCode::Right => Self::named("right"),
            KeyCode::Up => Self::named("up"),
            KeyCode::Down => Self::named("down"),
            KeyCode::Home => Self::named("home"),
            KeyCode::End => Self::named("end"),
            KeyCode::PageUp => Self::named("pageup"),
            KeyCode::PageDown => Self::named("pagedown"),
            KeyCode::Delete => Self::named("delete"),
            KeyCode::Insert => Self::named("insert"),
            KeyCode::F(n) => Self::named(&format!("f{n}")),
            _ => return None,
        };
        key.ctrl = event.modifiers.contains(KeyModifiers::CONTROL).then_some(true);
        key.alt = event.modifiers.contains(KeyModifiers::ALT).then_some(true);
        key.shift = event.modifiers.contains(KeyModifiers::SHIFT).then_some(true);
        Some(key)
    }

    pub fn to_raw(&self) -> Option<ReedlineRawEvent> {
        let event = Event::Key(KeyEvent::new(self.key_code()?, self.modifiers()));
        ReedlineRawEvent::try_from(event).ok()
    }
}

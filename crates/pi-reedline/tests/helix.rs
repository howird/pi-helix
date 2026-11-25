use pi_reedline::{Action, Engine, Key};

fn engine(text: &str) -> Engine {
    let mut e = Engine::new("helix").unwrap();
    e.set_text(text);
    e
}

/// Feed a helix-style key string: plain chars, `<esc>`, `<enter>`, `<s-enter>`.
fn keys(e: &mut Engine, spec: &str) -> Vec<Action> {
    let mut out = Vec::new();
    let mut rest = spec;
    while !rest.is_empty() {
        let key = if let Some(r) = rest.strip_prefix('<') {
            let end = r.find('>').unwrap();
            let name = &r[..end];
            rest = &r[end + 1..];
            match name {
                "esc" => Key::named("esc"),
                "enter" => Key::named("enter"),
                "s-enter" => Key::named("enter").shift(),
                "up" => Key::named("up"),
                "down" => Key::named("down"),
                "home" => Key::named("home"),
                "end" => Key::named("end"),
                "lt" => Key::char('<'),
                other => panic!("unknown key {other}"),
            }
        } else {
            let c = rest.chars().next().unwrap();
            rest = &rest[c.len_utf8()..];
            Key::char(c)
        };
        out.push(e.feed(&key).action);
    }
    out
}

fn buf(e: &Engine) -> String {
    e.snapshot().buffer
}

fn sel(e: &Engine) -> Option<String> {
    let s = e.snapshot();
    s.selection.map(|(a, b)| s.buffer[a..b].to_string())
}

#[test]
fn starts_in_insert_and_types() {
    let mut e = Engine::new("helix").unwrap();
    assert_eq!(e.snapshot().mode, "insert");
    keys(&mut e, "hello");
    assert_eq!(buf(&e), "hello");
    assert_eq!(e.snapshot().cursor, 5);
}

#[test]
fn esc_enters_normal() {
    let mut e = engine("hello");
    keys(&mut e, "<esc>");
    assert_eq!(e.snapshot().mode, "normal");
}

#[test]
fn word_delete() {
    let mut e = engine("foo bar baz");
    keys(&mut e, "<esc><home>");
    assert_eq!(e.snapshot().cursor, 0);
    keys(&mut e, "w");
    assert_eq!(sel(&e).as_deref(), Some("foo "));
    keys(&mut e, "d");
    assert_eq!(buf(&e), "bar baz");
}

#[test]
fn word_back_selection_extent() {
    let mut e = engine("foo bar");
    keys(&mut e, "<esc>b");
    assert_eq!(sel(&e).as_deref(), Some("bar"));
}

#[test]
fn match_inside_parens() {
    let mut e = engine("call(arg1, arg2)");
    keys(&mut e, "<esc><home>fg");
    keys(&mut e, "mi(");
    assert_eq!(sel(&e).as_deref(), Some("arg1, arg2"));
    keys(&mut e, "d");
    assert_eq!(buf(&e), "call()");
}

#[test]
fn count_prefix() {
    let mut e = engine("abcdef");
    keys(&mut e, "<esc><home>3l");
    assert_eq!(e.snapshot().cursor, 3);
    keys(&mut e, "d");
    assert_eq!(buf(&e), "abcef");
}

#[test]
fn open_line_below() {
    let mut e = engine("one");
    keys(&mut e, "<esc>o");
    assert_eq!(e.snapshot().mode, "insert");
    keys(&mut e, "two");
    assert_eq!(buf(&e), "one\ntwo");
}

#[test]
fn open_line_above_first_line() {
    let mut e = engine("one");
    keys(&mut e, "<esc>O");
    let opened = e.snapshot();
    assert_eq!(opened.mode, "insert");
    assert_eq!(opened.buffer, "\none");
    assert_eq!(opened.cursor, 0);
    keys(&mut e, "two");
    assert_eq!(buf(&e), "two\none");
}

#[test]
fn open_line_above_later_line() {
    let mut e = engine("one\nthree");
    keys(&mut e, "<esc>Otwo");
    assert_eq!(buf(&e), "one\ntwo\nthree");
}

#[test]
fn line_insert_commands_target_the_line_that_owns_the_newline() {
    for (command, cursor, expected) in [
        ("I", 0, "!abc\ndef"),
        ("A", 3, "abc!\ndef"),
        ("o", 4, "abc\n!\ndef"),
        ("O", 0, "!\nabc\ndef"),
        // The LF is still a selectable cell: `i` and `a` use its opposite edges.
        ("i", 3, "abc!\ndef"),
        ("a", 4, "abc\n!def"),
        ("c", 3, "abc!def"),
    ] {
        let mut e = engine("abc\ndef");
        keys(&mut e, "<esc>gg3l");
        assert_eq!(e.snapshot().selection, Some((3, 4)));
        keys(&mut e, command);
        let inserted = e.snapshot();
        assert_eq!(inserted.mode, "insert", "{command}");
        assert_eq!(inserted.cursor, cursor, "{command}");
        assert_eq!(inserted.selection, None, "{command}");
        keys(&mut e, "!");
        assert_eq!(buf(&e), expected, "{command}");
    }
}

#[test]
fn line_motions_target_the_line_that_owns_the_newline() {
    for (command, cursor, selection) in [
        ("<home>", 0, (0, 1)),
        ("gh", 0, (0, 1)),
        ("<end>", 2, (2, 3)),
        ("gl", 2, (2, 3)),
        ("v<home>", 0, (0, 4)),
        ("v<end>", 2, (2, 4)),
        ("vgl", 2, (2, 4)),
    ] {
        let mut e = engine("abc\ndef");
        keys(&mut e, "<esc>gg3l");
        keys(&mut e, command);
        assert_eq!(e.snapshot().cursor, cursor, "{command}");
        assert_eq!(e.snapshot().selection, Some(selection), "{command}");
    }
}

#[test]
fn line_insert_commands_handle_blank_lines_and_multibyte_graphemes() {
    for (text, setup, command, cursor, expected) in [
        ("a\n  \nz", "gg4l", "I", 2, "a\n!  \nz"),
        ("a\n\nz", "gg2l", "o", 3, "a\n\n!\nz"),
        ("a\n\nz", "gg2l", "O", 2, "a\n!\n\nz"),
        ("a\né\nz", "gg3l", "A", 4, "a\né!\nz"),
        ("a\né\nz", "gg3l", "O", 2, "a\n!\né\nz"),
        ("é\r\nz", "ggl", "A", 2, "é!\r\nz"),
        ("abc\ndef", "ggv3l", "I", 0, "!abc\ndef"),
        ("abc\ndef", "gg4lvh", "A", 3, "abc!\ndef"),
    ] {
        let mut e = engine(text);
        keys(&mut e, "<esc>");
        keys(&mut e, setup);
        keys(&mut e, command);
        assert_eq!(e.snapshot().cursor, cursor, "{text:?}: {setup}{command}");
        keys(&mut e, "!");
        assert_eq!(buf(&e), expected, "{text:?}: {setup}{command}");
    }
}

#[test]
fn counted_open_stacks_blank_lines_at_the_newline() {
    for (command, expected) in [
        ("3o", "abc\n!\n\n\ndef"),
        ("3O", "!\n\n\nabc\ndef"),
    ] {
        let mut e = engine("abc\ndef");
        keys(&mut e, "<esc>gg3l");
        keys(&mut e, command);
        keys(&mut e, "!");
        assert_eq!(buf(&e), expected, "{command}");
    }
}

#[test]
fn first_non_blank_motion_stays_put_on_a_blank_line() {
    let mut e = engine("a\n  \nz");
    keys(&mut e, "<esc>gg3lgs");
    assert_eq!(e.snapshot().cursor, 3);
}

#[test]
fn insert_mode_end_lands_before_the_newline() {
    let mut e = engine("abc\ndef");
    keys(&mut e, "<esc>ggi<end>!");
    assert_eq!(buf(&e), "abc!\ndef");
}

#[test]
fn insert_then_esc_round_trip() {
    let mut e = engine("ac");
    keys(&mut e, "<esc><home>li");
    assert_eq!(e.snapshot().mode, "insert");
    keys(&mut e, "b<esc>");
    assert_eq!(buf(&e), "abc");
    assert_eq!(e.snapshot().mode, "normal");
}

#[test]
fn select_mode_extends() {
    let mut e = engine("hello world");
    keys(&mut e, "<esc><home>v");
    assert_eq!(e.snapshot().mode, "select");
    keys(&mut e, "ll");
    assert_eq!(sel(&e).as_deref(), Some("hel"));
    keys(&mut e, "<esc>");
    assert_eq!(e.snapshot().mode, "normal");
}

#[test]
fn undo_redo() {
    let mut e = engine("foo bar");
    keys(&mut e, "<esc><home>wd");
    assert_eq!(buf(&e), "bar");
    keys(&mut e, "u");
    assert_eq!(buf(&e), "foo bar");
    keys(&mut e, "U");
    assert_eq!(buf(&e), "bar");
}

#[test]
fn yank_paste() {
    let mut e = engine("ab");
    keys(&mut e, "<esc><home>");
    let out = e.feed(&Key::char('y'));
    assert_eq!(out.yanked.as_deref(), Some("a"));
    keys(&mut e, "p");
    assert_eq!(buf(&e), "aab");
}

#[test]
fn enter_submits_in_insert() {
    let mut e = engine("hi");
    assert_eq!(keys(&mut e, "<enter>"), vec![Action::Submit]);
    assert_eq!(buf(&e), "hi");
}

#[test]
fn submit_preserves_the_current_mode() {
    for kind in ["helix", "vi"] {
        for (prepare, mode) in [("", "insert"), ("<esc>", "normal"), ("<esc>v", "select")] {
            let mut e = Engine::new(kind).unwrap();
            e.set_text("hi");
            keys(&mut e, prepare);
            assert_eq!(e.snapshot().mode, mode);
            assert_eq!(keys(&mut e, "<enter>"), [Action::Submit]);
            assert_eq!(e.snapshot().mode, mode, "{kind}");
            assert_eq!(buf(&e), "hi");
        }
    }
}

#[test]
fn vi_submit_does_not_leave_a_partial_operator_armed() {
    let mut e = Engine::new("vi").unwrap();
    e.set_text("abc");
    keys(&mut e, "<esc>d");
    assert_pending(&e, &[Key::char('d')]);
    assert_eq!(keys(&mut e, "<enter>"), [Action::Submit]);
    assert_pending(&e, &[]);
    assert_eq!(e.snapshot().mode, "normal");
}

#[test]
fn shift_enter_inserts_newline() {
    let mut e = engine("a");
    assert_eq!(keys(&mut e, "<s-enter>b"), vec![Action::None, Action::None]);
    assert_eq!(buf(&e), "a\nb");
}

#[test]
fn esc_in_normal_without_selection_aborts() {
    let mut e = engine("a");
    keys(&mut e, "<esc>");
    assert_eq!(keys(&mut e, "<esc>"), vec![Action::Abort]);
}

#[test]
fn esc_in_normal_with_selection_collapses() {
    let mut e = engine("foo bar");
    keys(&mut e, "<esc>b");
    assert_eq!(keys(&mut e, "<esc>"), vec![Action::None]);
    assert_eq!(keys(&mut e, "<esc>"), vec![Action::Abort]);
}

#[test]
fn arrows_only_move_the_cursor() {
    let mut e = engine("ab\ncd");
    e.move_to(4);
    assert_eq!(keys(&mut e, "<up>"), [Action::None]);
    assert_eq!(e.snapshot().cursor, 1);
    assert_eq!(keys(&mut e, "<up>"), [Action::Unhandled]);
    assert_eq!(e.snapshot().cursor, 1);
    assert_eq!(keys(&mut e, "<down>"), [Action::None]);
    assert_eq!(e.snapshot().cursor, 4);
    assert_eq!(keys(&mut e, "<down>"), [Action::Unhandled]);
    assert_eq!(e.snapshot().cursor, 4);
}

#[test]
fn counted_vertical_motion_stops_at_the_buffer_edge() {
    for mode in ["helix", "vi"] {
        let mut e = Engine::new(mode).unwrap();
        e.set_text("ab\ncd\nef");
        keys(&mut e, "<esc>");
        e.move_to(1);
        assert_eq!(keys(&mut e, "4j"), [Action::None; 2]);
        assert_eq!(e.snapshot().cursor, 7, "{mode}");
        assert_eq!(keys(&mut e, "4k"), [Action::None; 2]);
        assert_eq!(e.snapshot().cursor, 1, "{mode}");
        assert_eq!(buf(&e), "ab\ncd\nef");
        assert!(!e.pending());
    }
}

#[test]
fn unicode_offsets_are_bytes() {
    let e = engine("é");
    assert_eq!(e.snapshot().cursor, 2);
}

#[test]
fn vi_mode_works() {
    let mut e = Engine::new("vi").unwrap();
    e.set_text("foo bar");
    let mut k = |s| keys(&mut e, s);
    k("<esc>0dw");
    assert_eq!(buf(&e), "bar");
}

#[test]
fn pending_tracks_helix_counts_and_prefixes() {
    let mut e = engine("ab:c:def");
    keys(&mut e, "<esc><home>");
    let mut pending = Vec::new();
    for ch in ['2', 'm', 'i'] {
        let key = Key::char(ch);
        e.feed(&key);
        pending.push(key);
        assert_pending(&e, &pending);
    }
    assert_eq!(keys(&mut e, "<esc>"), [Action::None]);
    assert_pending(&e, &[]);
    assert_eq!(keys(&mut e, "<esc>"), [Action::Abort]);
    keys(&mut e, "f");
    assert_pending(&e, &[Key::char('f')]);
    keys(&mut e, ":");
    assert_pending(&e, &[]);
    assert_eq!(e.snapshot().cursor, 2);
}

fn assert_pending(e: &Engine, expected: &[Key]) {
    assert_eq!(e.pending_keys(), expected);
    assert_eq!(e.pending(), !expected.is_empty());
}

#[test]
fn helix_pending_retains_original_surround_argument_and_modifiers() {
    let mut e = engine("(x)");
    keys(&mut e, "<esc>mr");
    let old_surround = Key::char(')').ctrl().alt().shift();
    e.feed(&old_surround);
    assert_pending(&e, &[Key::char('m'), Key::char('r'), old_surround]);
    keys(&mut e, "]");
    assert_pending(&e, &[]);
}

#[test]
fn counted_goto_prefix_is_pending_in_vi_but_rejected_in_helix() {
    for mode in ["helix", "vi"] {
        let mut e = Engine::new(mode).unwrap();
        keys(&mut e, "<esc>2");
        assert_pending(&e, &[Key::char('2')]);
        keys(&mut e, "g");
        if mode == "vi" {
            assert_pending(&e, &[Key::char('2'), Key::char('g')]);
            keys(&mut e, "g");
        }
        assert_pending(&e, &[]);
    }
}

#[test]
fn vi_meta_prefix_replaces_the_old_sequence_and_retains_the_original_key() {
    let mut e = Engine::new("vi").unwrap();
    keys(&mut e, "<esc>d");
    let meta_find = Key::char('f').alt().shift();
    e.feed(&meta_find);
    assert_pending(&e, std::slice::from_ref(&meta_find));
    // Vi leaves an unbound non-character key out of the sequence.
    e.feed(&Key::named("f12"));
    assert_pending(&e, &[meta_find]);
    keys(&mut e, ":");
    assert_pending(&e, &[]);
}

#[test]
fn pending_tracks_vi_find_and_counted_operator() {
    let mut e = Engine::new("vi").unwrap();
    e.set_text("ab:c:def");
    keys(&mut e, "<esc>0f");
    assert!(e.pending());
    keys(&mut e, ":");
    assert!(!e.pending());
    assert_eq!(e.snapshot().cursor, 2);

    keys(&mut e, "0");
    let mut pending = Vec::new();
    for ch in ['d', '2', 'f'] {
        let key = Key::char(ch);
        e.feed(&key);
        pending.push(key);
        assert_pending(&e, &pending);
    }
    keys(&mut e, ":");
    assert_pending(&e, &[]);
    assert_eq!(buf(&e), "def");
}

#[test]
fn rejected_sequences_do_not_suppress_idle_escape() {
    for (mode, prefix) in [("helix", "g"), ("vi", "d")] {
        let mut e = Engine::new(mode).unwrap();
        e.set_text("ab:c:def");
        keys(&mut e, "<esc><home>z");
        assert!(!e.pending(), "rejected single key in {mode}");
        assert_eq!(keys(&mut e, "<esc>"), [Action::Abort]);

        keys(&mut e, prefix);
        assert!(e.pending());
        keys(&mut e, "z");
        assert_pending(&e, &[]);
        assert_eq!(keys(&mut e, "<esc>"), [Action::Abort]);

        keys(&mut e, prefix);
        assert!(e.pending());
        assert_eq!(keys(&mut e, "<esc>"), [Action::None]);
        assert_pending(&e, &[]);
        assert_eq!(keys(&mut e, "<esc>"), [Action::Abort]);
    }
}

#[test]
fn pending_clears_on_mode_switch_and_insert() {
    let mut e = engine("x");
    keys(&mut e, "<esc>3i");
    assert_pending(&e, &[]);
    keys(&mut e, "ab");
    assert_pending(&e, &[]);
}

#[test]
fn host_edits_cancel_the_parser_sequence() {
    for mode in ["helix", "vi"] {
        let mut e = Engine::new(mode).unwrap();
        e.set_text("ab:c:def");
        keys(&mut e, "<esc><home>f");
        assert!(e.pending());
        e.move_to(1);
        assert_pending(&e, &[]);
        keys(&mut e, ":");
        assert_eq!(e.snapshot().cursor, 1);

        keys(&mut e, "f");
        assert!(e.pending());
        e.insert_string("X");
        assert_pending(&e, &[]);
        let after = e.snapshot();
        keys(&mut e, ":");
        assert_eq!(e.snapshot(), after);

        keys(&mut e, "f");
        assert!(e.pending());
        e.set_text("ab:c:def");
        assert_pending(&e, &[]);
        let after = e.snapshot();
        keys(&mut e, ":");
        assert_eq!(e.snapshot(), after);
    }
}

#[test]
fn a_key_not_sent_to_the_parser_does_not_cancel_a_sequence() {
    let mut e = engine("ab:c:def");
    keys(&mut e, "<esc><home>f");
    assert!(e.pending());
    assert_eq!(e.feed(&Key::named("unknown")).action, Action::Unhandled);
    assert!(e.pending());
    keys(&mut e, ":");
    assert_eq!(e.snapshot().cursor, 2);
    assert!(!e.pending());
}

#[test]
fn insert_string_in_normal_keeps_block() {
    let mut e = engine("abc");
    keys(&mut e, "<esc><home>");
    e.insert_string("XY");
    assert_eq!(buf(&e), "XYabc");
    assert_eq!(e.snapshot().mode, "normal");
    assert_eq!(sel(&e).as_deref(), Some("a"));
}

#[test]
fn insert_string_in_normal_is_one_undo_step() {
    let mut e = engine("hello world");
    keys(&mut e, "<esc>");
    e.insert_string("XYZ");
    assert!(buf(&e).contains("XYZ"));
    keys(&mut e, "u");
    assert_eq!(buf(&e), "hello world");
}

#[test]
fn insert_string_in_normal_keeps_word_selection() {
    let mut e = engine("foo bar");
    keys(&mut e, "<esc><home>w");
    assert_eq!(sel(&e).as_deref(), Some("foo "));
    e.insert_string("X ");
    assert_eq!(buf(&e), "X foo bar");
}

#[test]
fn insert_string_in_insert_inserts_at_cursor() {
    let mut e = engine("ab");
    e.insert_string("c\nd");
    assert_eq!(buf(&e), "abc\nd");
    assert_eq!(e.snapshot().cursor, 5);
}

#[test]
fn reset_starts_with_a_new_parser_and_undo_baseline() {
    let mut e = engine("hello");
    e.set_text("later");
    keys(&mut e, "<esc>u3");
    assert_eq!(buf(&e), "hello");
    assert!(e.pending());
    e.reset();
    let s = e.snapshot();
    assert_eq!((s.buffer.as_str(), s.cursor, s.mode), ("", 0, "insert"));
    assert_pending(&e, &[]);
    keys(&mut e, "<esc>Uu");
    assert_eq!(buf(&e), "");
    keys(&mut e, "ihi<esc>");
    assert_eq!(buf(&e), "hi");
    keys(&mut e, "u");
    assert_eq!(buf(&e), "");
    keys(&mut e, "U");
    assert_eq!(buf(&e), "hi");
}

#[test]
fn set_text_is_one_undoable_replacement() {
    let mut e = engine("original");
    keys(&mut e, "<esc><home>w");
    e.set_text("new");
    assert_eq!(buf(&e), "new");
    assert_eq!(e.snapshot().mode, "normal");
    keys(&mut e, "u");
    assert_eq!(buf(&e), "original");
    keys(&mut e, "U");
    assert_eq!(buf(&e), "new");
}

#[test]
fn clear_undo_keeps_current_state_and_discards_both_stacks() {
    let mut e = engine("original");
    e.set_text("current");
    e.set_text("later");
    keys(&mut e, "<esc>uf");
    assert_eq!(buf(&e), "current");
    assert_pending(&e, &[Key::char('f')]);
    let before = e.snapshot();
    e.clear_undo();
    assert_eq!(e.snapshot(), before);
    assert_pending(&e, &[Key::char('f')]);
    assert_eq!(keys(&mut e, "<esc>"), [Action::None]);
    keys(&mut e, "U");
    assert_eq!(buf(&e), "current");
    keys(&mut e, "u");
    assert_eq!(buf(&e), "current");
    e.set_text("new edit");
    keys(&mut e, "u");
    assert_eq!(buf(&e), "current");
}

#[test]
fn submit_clear_preserves_register_but_cannot_undo_into_previous_prompt() {
    for (mode, yank) in [("helix", "wy"), ("vi", "yw")] {
        let mut e = Engine::new(mode).unwrap();
        e.set_text("keep word");
        keys(&mut e, "<esc><home>");
        keys(&mut e, yank);
        assert_eq!(keys(&mut e, "<enter>"), [Action::Submit]);
        e.set_text("");
        e.clear_undo();
        assert_eq!(e.snapshot().mode, "normal");
        keys(&mut e, "u");
        assert_eq!(buf(&e), "");
        keys(&mut e, "p");
        assert_eq!(buf(&e), "keep ", "{mode}");
        keys(&mut e, "uu");
        assert_eq!(buf(&e), "");
        if mode == "helix" {
            keys(&mut e, "U");
            assert_eq!(buf(&e), "keep ");
        }
    }
}

#[test]
fn esc_in_insert_does_not_abort() {
    let mut e = engine("hello");
    assert_eq!(keys(&mut e, "<esc>"), [Action::None]);
    let mut e = Engine::new("vi").unwrap();
    assert_eq!(keys(&mut e, "<esc>"), [Action::None]);
}

// Insert mode has Shift+arrow selections of its own (reedline's common
// selection bindings), with no resting block.

#[test]
fn insert_shift_selection_persists() {
    let mut e = engine("hello");
    e.feed(&Key::named("home"));
    e.feed(&Key::named("right").shift());
    assert_eq!(sel(&e).as_deref(), Some("h"));
    e.feed(&Key::named("right").shift());
    assert_eq!(sel(&e).as_deref(), Some("he"));
    assert_eq!(e.snapshot().mode, "insert");
}

#[test]
fn insert_string_replaces_insert_selection() {
    let mut e = engine("hello");
    e.feed(&Key::named("home"));
    e.feed(&Key::named("right").shift());
    e.insert_string("J");
    assert_eq!(buf(&e), "Jello");
}

#[test]
fn emacs_mode_is_rejected() {
    assert!(Engine::new("emacs").is_err());
}

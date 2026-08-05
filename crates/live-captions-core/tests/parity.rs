//! Ported from `apps/web/__tests__/unit/live-transcribe-core.test.ts`.
//!
//! These exist to prove the Rust port makes the same decisions as the
//! TypeScript original, and to fail loudly if upstream changes the algorithm
//! underneath us.

use cap_live_captions_core::{
    BARE_SEGMENT_DURATION_SECONDS, ChunkDecision, ChunkResult, ChunkWordInput, LiveTranscriptState,
    MAX_CHUNK_TAKE_SECONDS, PromotionVerdict, SegmentEntry, SegmentManifest, TranscriptWord,
    apply_chunk_to_live_transcript, can_promote_live_transcript, create_empty_live_transcript,
    live_transcript_to_edit_transcript, offset_chunk_words, parse_live_transcript,
    plan_next_live_chunk, render_caption_vtt,
};

fn seg(index: i64) -> SegmentEntry {
    SegmentEntry {
        index,
        duration: 2.0,
    }
}

fn manifest(audio_segments: Vec<SegmentEntry>, is_complete: bool) -> SegmentManifest {
    SegmentManifest {
        audio_segments,
        audio_init_uploaded: true,
        is_complete,
    }
}

fn plan(m: &SegmentManifest, last_processed_index: i64, target_seconds: f64) -> ChunkDecision {
    plan_next_live_chunk(
        m,
        last_processed_index,
        target_seconds,
        MAX_CHUNK_TAKE_SECONDS,
    )
}

fn chunk_parts(decision: &ChunkDecision) -> (Vec<i64>, i64, i64) {
    match decision {
        ChunkDecision::Chunk {
            entries,
            start_ms,
            duration_ms,
        } => (
            entries.iter().map(|entry| entry.index).collect(),
            *start_ms,
            *duration_ms,
        ),
        other => panic!("expected a chunk, got {other:?}"),
    }
}

#[test]
fn waits_while_there_is_not_enough_new_audio() {
    let m = manifest(vec![seg(1), seg(2), seg(3)], false);
    assert_eq!(plan(&m, 0, 15.0), ChunkDecision::Wait);
}

#[test]
fn emits_a_chunk_once_the_window_target_is_reached_with_the_right_offset() {
    let m = manifest((1..=8).map(seg).collect(), false);
    let (indices, start_ms, duration_ms) = chunk_parts(&plan(&m, 2, 10.0));

    assert_eq!(indices, vec![3, 4, 5, 6, 7, 8]);
    assert_eq!(start_ms, 4000);
    assert_eq!(duration_ms, 12000);
}

#[test]
fn emits_the_remainder_immediately_once_the_manifest_is_complete() {
    let m = manifest(vec![seg(1), seg(2), seg(3)], true);
    let (_, start_ms, duration_ms) = chunk_parts(&plan(&m, 2, 15.0));

    assert_eq!(start_ms, 4000);
    assert_eq!(duration_ms, 2000);
}

#[test]
fn caps_how_much_audio_one_chunk_may_take_when_catching_up() {
    let m = manifest((1..=60).map(seg).collect(), false);
    let decision = plan_next_live_chunk(&m, 0, 15.0, 20.0);
    let (_, _, duration_ms) = chunk_parts(&decision);

    assert_eq!(duration_ms, 20000);
}

#[test]
fn never_reads_past_a_segment_index_gap() {
    // segment 3 missing: only 1..2 may be considered
    let m = manifest(
        vec![seg(1), seg(2), seg(4), seg(5), seg(6), seg(7), seg(8)],
        true,
    );
    let (indices, start_ms, duration_ms) = chunk_parts(&plan(&m, 0, 2.0));

    assert_eq!(indices, vec![1, 2]);
    assert_eq!(start_ms, 0);
    assert_eq!(duration_ms, 4000);
}

#[test]
fn transcribes_segment_zero_of_a_zero_based_manifest_from_the_fresh_cursor_sentinel() {
    let m = manifest(vec![seg(0), seg(1), seg(2)], true);
    let (indices, start_ms, duration_ms) = chunk_parts(&plan(&m, -1, 15.0));

    assert_eq!(indices, vec![0, 1, 2]);
    assert_eq!(start_ms, 0);
    assert_eq!(duration_ms, 6000);
}

#[test]
fn finishes_when_a_completed_manifest_has_nothing_contiguous_left() {
    let m = manifest(vec![seg(1), seg(2), seg(4)], true);
    assert_eq!(plan(&m, 2, 15.0), ChunkDecision::Done);
}

#[test]
fn reports_no_audio_only_for_completed_manifests() {
    assert_eq!(
        plan(&manifest(vec![], true), 0, 15.0),
        ChunkDecision::NoAudio
    );
    assert_eq!(plan(&manifest(vec![], false), 0, 15.0), ChunkDecision::Wait);
}

#[test]
fn offsets_clamps_and_filters_words_onto_the_recording_timeline() {
    let words = offset_chunk_words(
        &[
            ChunkWordInput {
                text: "hello".into(),
                start: Some(100.0),
                end: Some(500.0),
                confidence: Some(0.9),
                speaker: None,
            },
            ChunkWordInput {
                text: "world".into(),
                start: Some(500.0),
                end: Some(99999.0),
                confidence: None,
                speaker: Some("A".into()),
            },
            ChunkWordInput {
                text: "".into(),
                start: Some(0.0),
                end: Some(100.0),
                ..Default::default()
            },
            ChunkWordInput {
                text: "bad".into(),
                start: None,
                end: Some(100.0),
                ..Default::default()
            },
        ],
        10_000,
        4_000,
    );

    assert_eq!(words.len(), 2);

    assert_eq!(words[0].text, "hello");
    assert_eq!(words[0].start_ms, 10_100);
    assert_eq!(words[0].end_ms, 10_500);
    assert_eq!(words[0].confidence, Some(0.9));

    // end clamped to the chunk bound
    assert_eq!(words[1].text, "world");
    assert_eq!(words[1].start_ms, 10_500);
    assert_eq!(words[1].end_ms, 14_000);
    assert_eq!(words[1].speaker.as_deref(), Some("A"));
}

#[test]
fn applies_chunks_idempotently() {
    let empty = create_empty_live_transcript("2026-08-03T00:00:00.000Z");

    let first = apply_chunk_to_live_transcript(
        &empty,
        ChunkResult {
            start_ms: 0,
            duration_ms: 4000,
            last_audio_segment_index: 2,
            words: offset_chunk_words(
                &[ChunkWordInput {
                    text: "First".into(),
                    start: Some(0.0),
                    end: Some(900.0),
                    ..Default::default()
                }],
                0,
                4000,
            ),
            language_code: Some("en".into()),
            now_iso: "2026-08-03T00:00:05.000Z".into(),
        },
    );

    let second = || ChunkResult {
        start_ms: 4000,
        duration_ms: 4000,
        last_audio_segment_index: 4,
        words: offset_chunk_words(
            &[ChunkWordInput {
                text: "second".into(),
                start: Some(200.0),
                end: Some(1000.0),
                ..Default::default()
            }],
            4000,
            4000,
        ),
        language_code: Some("en".into()),
        now_iso: "2026-08-03T00:00:09.000Z".into(),
    };

    let applied = apply_chunk_to_live_transcript(&first, second());
    // retrying the same chunk must not duplicate words
    let reapplied = apply_chunk_to_live_transcript(&applied, second());

    let texts: Vec<&str> = reapplied.words.iter().map(|w| w.text.as_str()).collect();
    assert_eq!(texts, vec!["First", "second"]);
    assert_eq!(reapplied.last_audio_segment_index, 4);
    assert_eq!(reapplied.transcribed_duration_ms, 8000);
    assert_eq!(reapplied.language_code.as_deref(), Some("en"));
    assert_eq!(reapplied.state, LiveTranscriptState::Active);

    // upstream asserts these three; dropping them is what let the unrendered
    // vtt field ship empty
    assert!(reapplied.vtt.starts_with("WEBVTT"));
    assert!(reapplied.vtt.contains("First"));
    assert!(reapplied.vtt.contains("second"));

    let json = serde_json::to_string(&reapplied).expect("serializes");
    assert_eq!(parse_live_transcript(&json), Some(reapplied));
}

#[test]
fn vtt_breaks_cues_on_punctuation_gaps_and_eight_words() {
    let word = |text: &str, start: i64, end: i64| TranscriptWord {
        id: String::new(),
        text: text.to_string(),
        start_ms: start,
        end_ms: end,
        confidence: None,
        speaker: None,
        channel: None,
    };

    let vtt = render_caption_vtt(&[
        word("Hello,", 0, 400),
        word("world", 500, 900),
        // >500ms gap forces a break after "world"
        word("again", 2000, 2400),
    ]);

    assert!(vtt.starts_with("WEBVTT\n\n"));
    assert!(vtt.contains("00:00:00.000 --> 00:00:00.400"));
    assert!(vtt.contains("Hello,"));
    assert!(vtt.contains("again"));
    assert_eq!(vtt.matches(" --> ").count(), 3);
}

#[test]
fn vtt_drops_filler_words_but_keeps_real_ones() {
    let word = |text: &str| TranscriptWord {
        id: String::new(),
        text: text.to_string(),
        start_ms: 0,
        end_ms: 100,
        confidence: None,
        speaker: None,
        channel: None,
    };

    let vtt = render_caption_vtt(&[word("um"), word("Ummm"), word("uh"), word("umbrella")]);

    assert!(vtt.contains("umbrella"));
    assert!(!vtt.contains("uh"));
    assert_eq!(render_caption_vtt(&[]), "WEBVTT\n\n");
}

#[test]
fn manifest_accepts_bare_number_segments_with_the_three_second_default() {
    // Video.ts models an entry as Union(Number, Struct) and normalizeSegmentEntry
    // gives a bare number a 3.0s duration. Rejecting the bare form failed the
    // whole manifest, which is indistinguishable from "no manifest yet".
    let m: SegmentManifest = serde_json::from_str(
        r#"{"audio_segments":[0,1,2],"audio_init_uploaded":true,"is_complete":true}"#,
    )
    .expect("bare-number manifest parses");

    assert_eq!(m.audio_segments.len(), 3);
    assert_eq!(m.audio_segments[0].duration, BARE_SEGMENT_DURATION_SECONDS);

    let (indices, start_ms, duration_ms) = chunk_parts(&plan(&m, -1, 15.0));
    assert_eq!(indices, vec![0, 1, 2]);
    assert_eq!(start_ms, 0);
    assert_eq!(duration_ms, 9000);
}

#[test]
fn manifest_tolerates_missing_optional_fields() {
    let m: SegmentManifest =
        serde_json::from_str(r#"{"audio_segments":[]}"#).expect("partial manifest parses");
    assert!(m.audio_segments.is_empty());
}

#[test]
fn parse_is_lenient_so_a_resume_never_discards_the_transcript() {
    // Every one of these previously returned None, which resets the cursor to
    // -1 and re-transcribes the recording from zero.
    let cases = [
        r#"{"version":1,"state":"paused","words":[]}"#,
        r#"{"version":1,"state":"active","languageCode":123,"words":[]}"#,
        r#"{"version":1,"state":"active","transcribedDurationMs":100.5,"words":[]}"#,
        r#"{"version":1,"state":"active"}"#,
    ];

    for case in cases {
        assert!(
            parse_live_transcript(case).is_some(),
            "should have parsed leniently: {case}"
        );
    }

    // offsetChunkWords emits a NaN endMs when an engine reports a non-finite
    // end, and JSON.stringify(NaN) writes null. One such word must not take
    // the whole document with it.
    let with_null_end = r#"{"version":1,"state":"active","words":[
        {"id":"w0","text":"kept","startMs":100,"endMs":null}
    ]}"#;
    let parsed = parse_live_transcript(with_null_end).expect("parses");
    assert_eq!(parsed.words.len(), 1);
    assert_eq!(parsed.words[0].text, "kept");
    assert_eq!(parsed.words[0].end_ms, 100);

    // a wrong version is still a hard reject
    assert_eq!(parse_live_transcript(r#"{"version":99}"#), None);
}

#[test]
fn revision_increments_so_concurrent_writers_are_orderable() {
    let empty = create_empty_live_transcript("2026-08-03T00:00:00.000Z");
    assert_eq!(empty.revision, 0);

    let chunk = || ChunkResult {
        start_ms: 0,
        duration_ms: 1000,
        last_audio_segment_index: 0,
        words: vec![],
        language_code: None,
        now_iso: "2026-08-03T00:00:01.000Z".into(),
    };

    let once = apply_chunk_to_live_transcript(&empty, chunk());
    let twice = apply_chunk_to_live_transcript(&once, chunk());

    assert_eq!(once.revision, 1);
    assert_eq!(twice.revision, 2);
}

#[test]
fn rejects_corrupt_segment_durations_rather_than_saturating() {
    let huge = SegmentManifest {
        audio_segments: vec![SegmentEntry {
            index: 0,
            duration: 1e300,
        }],
        audio_init_uploaded: true,
        is_complete: true,
    };

    // previously produced duration_ms == i64::MAX
    assert_eq!(plan(&huge, -1, 15.0), ChunkDecision::Wait);
}

#[test]
fn duplicate_indices_keep_the_first_and_do_not_shift_the_timeline() {
    let m = SegmentManifest {
        audio_segments: vec![
            SegmentEntry {
                index: 0,
                duration: 2.0,
            },
            SegmentEntry {
                index: 0,
                duration: 9.0,
            },
            SegmentEntry {
                index: 1,
                duration: 2.0,
            },
        ],
        audio_init_uploaded: true,
        is_complete: true,
    };

    let (indices, _, duration_ms) = chunk_parts(&plan(&m, -1, 1.0));
    assert_eq!(indices, vec![0, 1]);
    assert_eq!(duration_ms, 4000);
}

#[test]
fn non_uniform_durations_do_not_drift_the_running_offset() {
    let durations = [0.1_f64, 1.0 / 3.0, 2.7, 0.5, 1.9];
    let m = SegmentManifest {
        audio_segments: durations
            .iter()
            .enumerate()
            .map(|(i, d)| SegmentEntry {
                index: i as i64,
                duration: *d,
            })
            .collect(),
        audio_init_uploaded: true,
        is_complete: true,
    };

    // consume the first three, then confirm the fourth starts where they ended
    let expected_start = (durations[..3].iter().sum::<f64>() * 1000.0).round() as i64;
    let (indices, start_ms, _) = chunk_parts(&plan(&m, 2, 0.1));

    assert_eq!(indices, vec![3, 4]);
    assert_eq!(start_ms, expected_start);
}

#[test]
fn language_code_is_pinned_by_the_first_chunk_that_detects_one() {
    let empty = create_empty_live_transcript("2026-08-03T00:00:00.000Z");

    let pinned = apply_chunk_to_live_transcript(
        &empty,
        ChunkResult {
            start_ms: 0,
            duration_ms: 4000,
            last_audio_segment_index: 0,
            words: vec![],
            language_code: Some("en".into()),
            now_iso: "2026-08-03T00:00:05.000Z".into(),
        },
    );

    // a later chunk mis-detecting a different language must not win
    let after = apply_chunk_to_live_transcript(
        &pinned,
        ChunkResult {
            start_ms: 4000,
            duration_ms: 4000,
            last_audio_segment_index: 1,
            words: vec![],
            language_code: Some("de".into()),
            now_iso: "2026-08-03T00:00:09.000Z".into(),
        },
    );

    assert_eq!(after.language_code.as_deref(), Some("en"));
}

#[test]
fn rejects_malformed_artifacts() {
    assert_eq!(parse_live_transcript("not json"), None);
    assert_eq!(parse_live_transcript(r#"{"version":99}"#), None);
}

#[test]
fn promotes_only_full_gap_free_coverage() {
    let complete = manifest(vec![seg(1), seg(2), seg(3)], true);
    let mut artifact = create_empty_live_transcript("2026-08-03T00:00:00.000Z");
    artifact.last_audio_segment_index = 3;
    artifact.transcribed_duration_ms = 6000;

    assert_eq!(
        can_promote_live_transcript(&artifact, &complete),
        PromotionVerdict::Ok
    );
}

#[test]
fn declines_incomplete_manifests_partial_coverage_and_skipped_chunks() {
    let complete = manifest(vec![seg(1), seg(2), seg(3)], true);
    let base = || {
        let mut artifact = create_empty_live_transcript("2026-08-03T00:00:00.000Z");
        artifact.last_audio_segment_index = 3;
        artifact.transcribed_duration_ms = 6000;
        artifact
    };

    let incomplete = manifest(vec![seg(1), seg(2), seg(3)], false);
    assert_ne!(
        can_promote_live_transcript(&base(), &incomplete),
        PromotionVerdict::Ok
    );

    let mut partial = base();
    partial.last_audio_segment_index = 2;
    assert_ne!(
        can_promote_live_transcript(&partial, &complete),
        PromotionVerdict::Ok
    );

    let mut gapped = base();
    gapped.has_gaps = true;
    assert_ne!(
        can_promote_live_transcript(&gapped, &complete),
        PromotionVerdict::Ok
    );
}

#[test]
fn declines_manifests_with_segment_index_gaps() {
    let gapped_manifest = manifest(vec![seg(1), seg(2), seg(4)], true);
    let mut artifact = create_empty_live_transcript("2026-08-03T00:00:00.000Z");
    artifact.last_audio_segment_index = 4;

    assert_ne!(
        can_promote_live_transcript(&artifact, &gapped_manifest),
        PromotionVerdict::Ok
    );
}

#[test]
fn declines_recordings_with_no_audio() {
    let silent = manifest(vec![], true);
    let mut artifact = create_empty_live_transcript("2026-08-03T00:00:00.000Z");
    artifact.last_audio_segment_index = 3;

    assert_ne!(
        can_promote_live_transcript(&artifact, &silent),
        PromotionVerdict::Ok
    );
}

#[test]
fn shapes_accumulated_words_as_a_canonical_edit_transcript() {
    let artifact = apply_chunk_to_live_transcript(
        &create_empty_live_transcript("2026-08-03T00:00:00.000Z"),
        ChunkResult {
            start_ms: 0,
            duration_ms: 2500,
            last_audio_segment_index: 1,
            words: offset_chunk_words(
                &[ChunkWordInput {
                    text: "Hello".into(),
                    start: Some(0.0),
                    end: Some(400.0),
                    ..Default::default()
                }],
                0,
                2500,
            ),
            language_code: Some("en".into()),
            now_iso: "2026-08-03T00:00:03.000Z".into(),
        },
    );

    let edit = live_transcript_to_edit_transcript(&artifact, "parakeet-tdt-0.6b-v3-int8");

    // hard-coded in the crate: an upstream bump must fail here, not silently
    // write a stale version
    assert_eq!(edit.version, 3);
    assert_eq!(edit.speech_model_used, "parakeet-tdt-0.6b-v3-int8");
    assert_eq!(edit.duration_ms, 2500);
    assert_eq!(edit.language_code.as_deref(), Some("en"));
    assert_eq!(edit.words.len(), 1);
    assert_eq!(edit.words[0].text, "Hello");
}

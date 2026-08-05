//! Chunk scheduling and transcript accumulation for on-device live captions.
//!
//! Ported from `apps/web/lib/live-transcribe-core.ts`, which runs the same
//! decisions server-side against AssemblyAI. Keeping the logic identical means
//! the share page consumes one artifact format regardless of which side
//! produced it, and upstream's own test suite doubles as our parity oracle.
//!
//! This crate is deliberately free of platform dependencies so it builds and
//! tests without the Apple toolchain the desktop crate requires.

use serde::{Deserialize, Serialize};

/// First chunk fires fast so a transcript exists almost immediately.
pub const INITIAL_CHUNK_SECONDS: f64 = 5.0;
/// Steady-state window. Small on purpose: the untranscribed tail at stop
/// averages half this, and that tail is all that stands between "stop" and a
/// complete transcript on the share page.
pub const MAX_CHUNK_SECONDS: f64 = 10.0;
pub const GROW_AFTER_CHUNKS: u32 = 2;
/// Catch-up bound: one chunk never covers more audio than this.
pub const MAX_CHUNK_TAKE_SECONDS: f64 = 60.0;
pub const MAX_TRANSCRIBED_SECONDS: f64 = 60.0 * 60.0;
pub const MAX_CHUNKS: u32 = 420;
pub const MAX_CHUNK_ATTEMPTS: u32 = 2;

pub const LIVE_TRANSCRIPT_VERSION: u32 = 1;
/// Sentinel for "nothing processed yet": 0 is a legitimate segment index in
/// 0-based manifests, so the cursor starts below every real index.
pub const LIVE_TRANSCRIPT_NO_SEGMENTS: i64 = -1;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SegmentEntry {
    pub index: i64,
    /// Seconds, matching the manifest's own units.
    pub duration: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SegmentManifest {
    pub audio_segments: Vec<SegmentEntry>,
    pub audio_init_uploaded: bool,
    pub is_complete: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SegmentsAudioPlan {
    Unavailable { reason: String },
    NoAudio,
    Ok { entries: Vec<SegmentEntry> },
}

/// Decide whether a segment manifest can back an audio extraction.
///
/// `require_complete` guards the canonical path, which must never transcribe a
/// partial recording. The live path passes `false` on purpose.
pub fn plan_segments_audio_extraction(
    manifest: &SegmentManifest,
    require_complete: bool,
) -> SegmentsAudioPlan {
    if require_complete && !manifest.is_complete {
        return SegmentsAudioPlan::Unavailable {
            reason: "manifest is not complete".to_string(),
        };
    }

    if manifest.audio_segments.is_empty() {
        return SegmentsAudioPlan::NoAudio;
    }

    // The init flag can't prove absence when segments are listed: version 1
    // manifests uploaded audio segments while never setting it. Mid-recording
    // it only means the init may not have arrived yet.
    if !manifest.is_complete && !manifest.audio_init_uploaded {
        return SegmentsAudioPlan::Unavailable {
            reason: "audio init not uploaded yet".to_string(),
        };
    }

    let mut entries: Vec<SegmentEntry> = Vec::new();
    for raw in &manifest.audio_segments {
        if !raw.index.is_positive() && raw.index != 0 {
            return SegmentsAudioPlan::Unavailable {
                reason: format!("invalid audio segment entry (index={})", raw.index),
            };
        }
        if !raw.duration.is_finite() || raw.duration < 0.0 {
            return SegmentsAudioPlan::Unavailable {
                reason: format!("invalid audio segment entry (index={})", raw.index),
            };
        }
        if !entries.iter().any(|entry| entry.index == raw.index) {
            entries.push(*raw);
        }
    }

    entries.sort_by_key(|entry| entry.index);

    SegmentsAudioPlan::Ok { entries }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ChunkDecision {
    Wait,
    NoAudio,
    Done,
    Chunk {
        entries: Vec<SegmentEntry>,
        start_ms: i64,
        duration_ms: i64,
    },
}

/// Choose the next contiguous run of unprocessed audio segments.
///
/// Segments after an index gap are never taken — a missing upload would
/// silently shift every later word — so a mid-recording gap pauses live
/// transcription and a gap in a completed manifest ends it.
pub fn plan_next_live_chunk(
    manifest: &SegmentManifest,
    last_processed_index: i64,
    target_seconds: f64,
    max_take_seconds: f64,
) -> ChunkDecision {
    let entries = match plan_segments_audio_extraction(manifest, false) {
        SegmentsAudioPlan::NoAudio => {
            return if manifest.is_complete {
                ChunkDecision::NoAudio
            } else {
                ChunkDecision::Wait
            };
        }
        SegmentsAudioPlan::Unavailable { .. } => return ChunkDecision::Wait,
        SegmentsAudioPlan::Ok { entries } => entries,
    };

    let mut start_ms = 0.0_f64;
    let mut pending: Vec<SegmentEntry> = Vec::new();
    let mut expected_index = if entries.first().map(|entry| entry.index) == Some(0) {
        0
    } else {
        1
    };

    for entry in &entries {
        if entry.index != expected_index {
            break;
        }
        expected_index += 1;

        if entry.index <= last_processed_index {
            start_ms += entry.duration * 1000.0;
        } else {
            pending.push(*entry);
        }
    }

    if pending.is_empty() {
        return if manifest.is_complete {
            ChunkDecision::Done
        } else {
            ChunkDecision::Wait
        };
    }

    let mut taken: Vec<SegmentEntry> = Vec::new();
    let mut taken_seconds = 0.0_f64;
    for entry in &pending {
        if !taken.is_empty() && taken_seconds + entry.duration > max_take_seconds {
            break;
        }
        taken.push(*entry);
        taken_seconds += entry.duration;
        if taken_seconds >= max_take_seconds {
            break;
        }
    }

    let took_everything = taken.len() == pending.len();
    if !manifest.is_complete && took_everything && taken_seconds < target_seconds {
        return ChunkDecision::Wait;
    }

    ChunkDecision::Chunk {
        entries: taken,
        start_ms: start_ms.round() as i64,
        duration_ms: (taken_seconds * 1000.0).round() as i64,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWord {
    pub id: String,
    pub text: String,
    pub start_ms: i64,
    pub end_ms: i64,
    pub confidence: Option<f64>,
    pub speaker: Option<String>,
    pub channel: Option<String>,
}

/// One word as produced by a local engine, chunk-relative in milliseconds.
#[derive(Debug, Clone, Default)]
pub struct ChunkWordInput {
    pub text: String,
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub confidence: Option<f64>,
    pub speaker: Option<String>,
}

/// Place a chunk's words on the recording timeline. Words outside the chunk
/// bounds are clamped, invalid ones dropped.
pub fn offset_chunk_words(
    words: &[ChunkWordInput],
    chunk_start_ms: i64,
    chunk_duration_ms: i64,
) -> Vec<TranscriptWord> {
    let mut result = Vec::new();

    for (index, word) in words.iter().enumerate() {
        let text = word.text.trim();
        let (Some(start), Some(end)) = (word.start, word.end) else {
            continue;
        };
        if text.is_empty() || !start.is_finite() {
            continue;
        }

        let clamp = |value: f64| -> i64 {
            if !value.is_finite() {
                return 0;
            }
            (value.round() as i64).clamp(0, chunk_duration_ms)
        };

        let start_ms = chunk_start_ms + clamp(start);
        let end_ms = chunk_start_ms + clamp(end).max(clamp(start));

        result.push(TranscriptWord {
            id: format!("live-{chunk_start_ms}-{index}"),
            text: text.to_string(),
            start_ms,
            end_ms,
            confidence: word.confidence,
            speaker: word.speaker.clone(),
            channel: None,
        });
    }

    result
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveTranscriptState {
    Active,
    Complete,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTranscriptArtifact {
    pub version: u32,
    pub state: LiveTranscriptState,
    pub language_code: Option<String>,
    pub last_audio_segment_index: i64,
    pub transcribed_duration_ms: i64,
    pub words: Vec<TranscriptWord>,
    /// Rendered by the caller; see `render_vtt` on the roadmap in
    /// `.oneaway/specs/2026-08-05-local-live-transcription-design.md`.
    pub vtt: String,
    pub updated_at: String,
    /// A chunk was skipped after repeated failures, so some speech is missing.
    /// Disqualifies the artifact from promotion to the canonical transcript.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub has_gaps: bool,
}

pub fn get_live_transcript_object_key(owner_id: &str, video_id: &str) -> String {
    format!("{owner_id}/{video_id}/transcription.live.json")
}

pub fn create_empty_live_transcript(now_iso: &str) -> LiveTranscriptArtifact {
    LiveTranscriptArtifact {
        version: LIVE_TRANSCRIPT_VERSION,
        state: LiveTranscriptState::Active,
        language_code: None,
        last_audio_segment_index: LIVE_TRANSCRIPT_NO_SEGMENTS,
        transcribed_duration_ms: 0,
        words: Vec::new(),
        vtt: String::new(),
        updated_at: now_iso.to_string(),
        has_gaps: false,
    }
}

pub fn parse_live_transcript(value: &str) -> Option<LiveTranscriptArtifact> {
    let artifact: LiveTranscriptArtifact = serde_json::from_str(value).ok()?;
    if artifact.version != LIVE_TRANSCRIPT_VERSION {
        return None;
    }
    Some(artifact)
}

pub struct ChunkResult {
    pub start_ms: i64,
    pub duration_ms: i64,
    pub last_audio_segment_index: i64,
    pub words: Vec<TranscriptWord>,
    pub language_code: Option<String>,
    pub now_iso: String,
}

/// Merge one transcribed chunk into the artifact. Idempotent per chunk range:
/// a retried chunk first evicts any words at or after its start.
///
/// `language_code` is first-write-wins, which is what pins a recording to one
/// language: per-chunk detection on 5-10s of audio is unreliable and would
/// otherwise let the language flap mid-recording.
pub fn apply_chunk_to_live_transcript(
    artifact: &LiveTranscriptArtifact,
    chunk: ChunkResult,
) -> LiveTranscriptArtifact {
    let mut words: Vec<TranscriptWord> = artifact
        .words
        .iter()
        .filter(|word| word.start_ms < chunk.start_ms)
        .cloned()
        .collect();
    words.extend(chunk.words);

    LiveTranscriptArtifact {
        language_code: artifact.language_code.clone().or(chunk.language_code),
        last_audio_segment_index: artifact
            .last_audio_segment_index
            .max(chunk.last_audio_segment_index),
        transcribed_duration_ms: artifact
            .transcribed_duration_ms
            .max(chunk.start_ms + chunk.duration_ms),
        words,
        updated_at: chunk.now_iso,
        ..artifact.clone()
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum PromotionVerdict {
    Ok,
    Declined { reason: String },
}

/// Whether the accumulated live transcript may replace the canonical one.
///
/// Anything short of complete, gap-free coverage defers to the full-pass
/// transcription instead.
pub fn can_promote_live_transcript(
    artifact: &LiveTranscriptArtifact,
    manifest: &SegmentManifest,
) -> PromotionVerdict {
    let declined = |reason: String| PromotionVerdict::Declined { reason };

    if !manifest.is_complete {
        return declined("manifest is not complete".to_string());
    }
    if artifact.has_gaps {
        return declined("live transcript has skipped chunks".to_string());
    }

    let entries = match plan_segments_audio_extraction(manifest, true) {
        SegmentsAudioPlan::NoAudio => return declined("recording has no audio".to_string()),
        SegmentsAudioPlan::Unavailable { reason } => return declined(reason),
        SegmentsAudioPlan::Ok { entries } => entries,
    };

    let Some(last_index) = entries.last().map(|entry| entry.index) else {
        return declined("recording has no audio".to_string());
    };
    if artifact.last_audio_segment_index != last_index {
        return declined(format!(
            "covered up to segment {} of {last_index}",
            artifact.last_audio_segment_index
        ));
    }

    let mut expected = entries.first().map_or(1, |entry| entry.index);
    for entry in &entries {
        if entry.index != expected {
            return declined(format!("segment gap at index {expected}"));
        }
        expected += 1;
    }

    PromotionVerdict::Ok
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EditTranscript {
    pub version: u32,
    pub speech_model_used: String,
    pub duration_ms: i64,
    pub language_code: Option<String>,
    pub words: Vec<TranscriptWord>,
}

/// Shape the accumulated live words as a canonical edit transcript.
///
/// `speech_model_used` records the concrete local model (e.g.
/// `parakeet-tdt-0.6b-v3-int8`) so quality regressions stay attributable.
pub fn live_transcript_to_edit_transcript(
    artifact: &LiveTranscriptArtifact,
    edit_transcript_version: u32,
    speech_model_used: &str,
) -> EditTranscript {
    EditTranscript {
        version: edit_transcript_version,
        speech_model_used: speech_model_used.to_string(),
        duration_ms: artifact.transcribed_duration_ms.max(0),
        language_code: artifact.language_code.clone(),
        words: artifact.words.clone(),
    }
}

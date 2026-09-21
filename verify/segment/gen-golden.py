"""Regenerate segment-fixtures/python-golden.json from the real h3studio engine.

Read-only against /mnt/ssd/h3studio: imports the module, never writes there.
The TS port (src/lib/studio/segment-engine.ts) must deep-equal every case.

Dialogue-aligned segmentation cases per card SEG1: short dialogue, long
dialogue crossing a native boundary, multi-speaker turns, dense overlapping
dialogue — plus the surrounding passes (planning, speech protection, atomic
shots, lanes, timed-text scoping, seeds, cache reuse).

Run:  python3 verify/segment/gen-golden.py   (from the repo root)
"""

import json
import sys
from pathlib import Path

H3STUDIO = "/mnt/ssd/h3studio"
sys.path.insert(0, H3STUDIO)

import segment_engine as se  # noqa: E402


def case(name, fn, *args, **kwargs):
    """Run one case against the real engine; serialize RenderSegment outputs."""
    try:
        out = fn(*args, **kwargs)
    except Exception as exc:  # noqa: BLE001 — error paths are golden too
        return {"name": name, "fn": fn.__name__, "args": _dump_args(args),
                "kwargs": kwargs, "error": f"{type(exc).__name__}: {exc}"}
    return {"name": name, "fn": fn.__name__, "args": _dump_args(args),
            "kwargs": kwargs, "output": _dump(out)}


def _dump(value):
    if isinstance(value, se.RenderSegment):
        return value.to_dict()
    if isinstance(value, list):
        return [_dump(row) for row in value]
    return value


def _dump_args(args):
    dumped = []
    for value in args:
        if isinstance(value, se.RenderSegment):
            dumped.append({"__segments__": [value.to_dict()]})
        elif isinstance(value, list) and value and isinstance(value[0], se.RenderSegment):
            dumped.append({"__segments__": [row.to_dict() for row in value]})
        else:
            dumped.append(value)
    return dumped


def segs(*bounds):
    """Build RenderSegments from (start, end) pairs like the app does."""
    rows = []
    for index, (start, end) in enumerate(bounds):
        rows.append(se.RenderSegment(
            f"shot_{round(start * 1000):09d}_{round(end * 1000):09d}",
            index, float(start), float(end),
            core_start_seconds=float(start), core_end_seconds=float(end),
            continuity_mode="none" if index == 0 else "match_action",
        ))
    return rows


def speech(start, end, role="dialogue", speaker="S1", lip_sync=True, **extra):
    return {"content_role": role, "start_seconds": start, "end_seconds": end,
            "speaker": speaker, "lip_sync": lip_sync, **extra}


def shot(index, start, end, action, **extra):
    return {"id": f"S{index}", "start_seconds": start, "end_seconds": end,
            "subject_action": action, **extra}


cases = [
    # ---- plan_render_segments: compatibility + overlap split + grid snap ----
    case("plan_within_native_single", se.plan_render_segments, 0.0, 10.0),
    case("plan_exactly_native_single", se.plan_render_segments, 0.0, 15.0),
    case("plan_45s_overlap_split", se.plan_render_segments, 0.0, 45.0),
    case("plan_17s_overlap_split", se.plan_render_segments, 0.0, 17.0),
    case("plan_grid_snap_bankers", se.plan_render_segments, 0.25, 30.75),
    case("plan_end_not_later", se.plan_render_segments, 5.0, 5.0),
    case("plan_bad_overlap", se.plan_render_segments, 0.0, 30.0, overlap_seconds=15.0),

    # ---- plan_shot_render_segments: shot-aligned units ----
    case("shotplan_short_beat_merged_forward", se.plan_shot_render_segments, 0.0, 12.0, [
        shot(1, 0.0, 1.0, "S1 bullet-time cue, one heartbeat."),
        shot(2, 1.0, 12.0, "S2 recovers and circles left."),
    ]),
    case("shotplan_gap_covered", se.plan_shot_render_segments, 0.0, 20.0, [
        shot(1, 0.0, 5.0, "S1 advances through the alley."),
        shot(2, 8.0, 15.0, "S2 vaults the crate and lands."),
    ]),
    case("shotplan_long_shot_split", se.plan_shot_render_segments, 0.0, 40.0, [
        shot(1, 0.0, 40.0, "S1 and S2 circle each other across the rooftop."),
    ]),
    case("shotplan_no_shots_fallback", se.plan_shot_render_segments, 0.0, 30.0, []),
    case("shotplan_shotless_error", se.plan_shot_render_segments, 0.0, 12.0, [
        shot(1, 0.0, 4.0, "S1 advances through the alley."),
    ]),
    case("shotplan_shot_larger_than_max", se.plan_shot_render_segments, 0.0, 18.0, [
        shot(1, 0.0, 16.0, "S1 unleashes the ultimate finisher."),
        shot(2, 16.0, 18.0, "S2 collapses to one knee."),
    ]),

    # ---- protect_segment_boundaries_from_speech ----
    # 長對白：一句12s對白騎住15s邊界 → 成句推入前一個request
    case("speech_long_line_crossing_boundary",
         se.protect_segment_boundaries_from_speech,
         segs((0.0, 15.0), (15.0, 30.0)),
         [speech(10.0, 22.0, speaker="S1")]),
    # hard blocker：邊界切開對白 → 剪去對白之後
    case("speech_hard_block_forward",
         se.protect_segment_boundaries_from_speech,
         segs((0.0, 15.0), (15.0, 30.0)),
         [speech(13.0, 17.0, speaker="S1")]),
    # decay tail：對白喺邊界前啱啱完 → 讓出1s尾音
    case("speech_tail_block",
         se.protect_segment_boundaries_from_speech,
         segs((0.0, 15.0), (15.0, 30.0)),
         [speech(12.0, 15.0, speaker="S1")]),
    # tail 讓位唔可以撞入下一句
    case("speech_tail_respects_next_line",
         se.protect_segment_boundaries_from_speech,
         segs((0.0, 15.0), (15.0, 30.0)),
         [speech(12.0, 15.0, speaker="S1"), speech(15.5, 18.0, speaker="S2")]),
    # 密集對白：三句連續跨兩個15s窗（packed sequence → 插新窗）
    case("speech_packed_dense_dialogue",
         se.protect_segment_boundaries_from_speech,
         segs((0.0, 15.0), (15.0, 30.0), (30.0, 45.0)),
         [speech(0.0, 14.0, speaker="S1"), speech(14.0, 29.0, speaker="S2"),
          speech(29.0, 44.0, speaker="S1")]),
    case("speech_non_speech_roles_ignored",
         se.protect_segment_boundaries_from_speech,
         segs((0.0, 15.0), (15.0, 30.0)),
         [speech(13.0, 17.0, role="sfx"), speech(14.0, 16.0, role="music")]),
    case("speech_empty_rows_unchanged",
         se.protect_segment_boundaries_from_speech,
         segs((0.0, 15.0), (15.0, 30.0)),
         []),
    # 多角色輪流講：連續短句各自留喺所屬request
    case("speech_multi_speaker_sequence",
         se.protect_segment_boundaries_from_speech,
         segs((0.0, 15.0), (15.0, 30.0)),
         [speech(2.0, 5.0, speaker="S1"), speech(5.5, 9.0, speaker="S2"),
          speech(14.0, 17.0, speaker="S3")]),

    # ---- protect_segment_boundaries_from_atomic_shots ----
    case("atomic_signature_move_boundary",
         se.protect_segment_boundaries_from_atomic_shots,
         segs((0.0, 15.0), (15.0, 30.0)),
         [shot(1, 0.0, 8.0, "S1 advances, guarding high."),
          shot(2, 8.0, 16.0, "S1 unleashes the ultimate finisher.")]),
    case("atomic_flag_field",
         se.protect_segment_boundaries_from_atomic_shots,
         segs((0.0, 15.0), (15.0, 30.0)),
         [shot(1, 8.0, 16.0, "S1 presses the attack.", atomic_render=True)]),
    case("atomic_cjk_named_technique",
         se.protect_segment_boundaries_from_atomic_shots,
         segs((0.0, 15.0), (15.0, 30.0)),
         [shot(1, 8.0, 16.0, "無界紫電拳 全開。")]),
    case("atomic_text_layer_overlap",
         se.protect_segment_boundaries_from_atomic_shots,
         segs((0.0, 15.0), (15.0, 30.0)),
         [shot(1, 8.0, 16.0, "S1 presses the attack.")],
         text_layers=[{"shot_id": "S1", "content": "絕招: 無界紫電拳",
                       "start_seconds": 9.0, "end_seconds": 15.0}]),
    case("atomic_longer_than_native_stays_splittable",
         se.protect_segment_boundaries_from_atomic_shots,
         segs((0.0, 15.0), (15.0, 30.0)),
         [shot(1, 0.0, 20.0, "S1 unleashes the ultimate finisher.")]),
    case("atomic_none_unchanged",
         se.protect_segment_boundaries_from_atomic_shots,
         segs((0.0, 15.0), (15.0, 30.0)),
         [shot(1, 0.0, 16.0, "S1 circles left.")]),

    # ---- align_segments_to_dialogue_turns（dialogue-aligned核心）----
    # 短對白：單一request入面 → 唔使郁
    case("align_short_dialogue_single_segment",
         se.align_segments_to_dialogue_turns,
         segs((0.0, 10.0)),
         [speech(2.0, 4.5, speaker="S1")]),
    # 邊界經靜音位推前 → 第一句對白由local 0開始
    case("align_boundary_moves_to_first_turn",
         se.align_segments_to_dialogue_turns,
         segs((6.0, 15.0), (15.0, 30.0)),
         [speech(7.0, 9.0, speaker="S1"), speech(15.5, 18.0, speaker="S2")]),
    # first turn超出native窗（segment起點太遠）→ 邊界唔郁
    case("align_boundary_stays_when_turn_beyond_native",
         se.align_segments_to_dialogue_turns,
         segs((0.0, 15.0), (15.0, 30.0)),
         [speech(1.0, 3.0, speaker="S1"), speech(15.5, 18.0, speaker="S2")]),
    # 多角色：換人開聲 → 插新邊界
    case("align_multi_speaker_inserts",
         se.align_segments_to_dialogue_turns,
         segs((0.0, 30.0)),
         [speech(1.0, 4.0, speaker="S1"), speech(6.0, 9.0, speaker="S2"),
          speech(11.0, 14.0, speaker="S1")]),
    # 密集多段：同講者但靜音≥1.5s → 都開新request
    case("align_same_speaker_long_silence",
         se.align_segments_to_dialogue_turns,
         segs((0.0, 30.0)),
         [speech(1.0, 4.0, speaker="S1"), speech(8.0, 11.0, speaker="S1")]),
    # 疊住/打斷：同屬一個request，唔准切
    case("align_interrupting_overlap_stays",
         se.align_segments_to_dialogue_turns,
         segs((0.0, 30.0)),
         [speech(1.0, 8.0, speaker="S1"), speech(5.0, 12.0, speaker="S2")]),
    # 非lip-sync（發力喝聲）→ 唔切combat chain
    case("align_non_lipsync_exertion_ignored",
         se.align_segments_to_dialogue_turns,
         segs((0.0, 15.0), (15.0, 30.0)),
         [speech(2.0, 4.0, speaker="S1", lip_sync=False),
          speech(18.0, 20.0, speaker="S2", lip_sync=False)]),
    # voice_over/lyrics 唔觸發speaker切
    case("align_voice_over_only_unchanged",
         se.align_segments_to_dialogue_turns,
         segs((0.0, 30.0)),
         [speech(2.0, 6.0, role="voice_over"), speech(10.0, 14.0, role="lyrics")]),
    case("align_empty_rows_unchanged",
         se.align_segments_to_dialogue_turns,
         segs((0.0, 15.0), (15.0, 30.0)),
         []),

    # ---- plan_speech_track_lanes ----
    case("lanes_overlap_second_clip_new_lane", se.plan_speech_track_lanes, [
        speech(1.0, 5.0, layer_id="d1"),
        speech(3.0, 7.0, layer_id="d2"),
    ]),
    case("lanes_sequential_policy_moves", se.plan_speech_track_lanes, [
        speech(1.0, 5.0, layer_id="d1"),
        speech(3.0, 7.0, layer_id="d2", overlap_policy="sequential"),
    ]),
    case("lanes_roles_independent", se.plan_speech_track_lanes, [
        speech(1.0, 5.0, role="dialogue", layer_id="d1"),
        speech(1.0, 5.0, role="voice_over", layer_id="v1"),
        speech(1.0, 5.0, role="lyrics", layer_id="l1"),
    ]),
    case("lanes_breath_guard", se.plan_speech_track_lanes, [
        speech(1.0, 5.0, layer_id="d1"),
        speech(5.5, 9.0, layer_id="d2"),
    ], guard_seconds=1.0),
    case("lanes_non_speech_ignored", se.plan_speech_track_lanes, [
        speech(1.0, 5.0, role="sfx", layer_id="x1"),
        speech(1.0, 5.0, layer_id="d1"),
    ]),
    case("lanes_alias_normalization", se.plan_speech_track_lanes, [
        speech(1.0, 5.0, layer_id="d1"),
        speech(3.0, 7.0, layer_id="d2", overlap_policy="no-overlap"),
    ]),

    # ---- normalize_speech_overlap_policy ----
    case("normalize_default", se.normalize_speech_overlap_policy, None),
    case("normalize_auto", se.normalize_speech_overlap_policy, "auto"),
    case("normalize_allow_alias", se.normalize_speech_overlap_policy, "Allow Overlap"),
    case("normalize_no_overlap_alias", se.normalize_speech_overlap_policy, "no-overlap"),
    case("normalize_sequence_alias", se.normalize_speech_overlap_policy, "Sequence"),
    case("normalize_unknown_falls_back", se.normalize_speech_overlap_policy, "whenever"),

    # ---- scope_timed_prompt_text ----
    case("scope_two_phase_range_window_tail",
         se.scope_timed_prompt_text,
         "daylight cotton fields (0-16s) transitioning to a night rubber plantation (16-30s)",
         20.0, 30.0),
    case("scope_range_head_half_clipped",
         se.scope_timed_prompt_text,
         "daylight cotton fields (0-16s) then a night rubber plantation (16-30s)",
         10.0, 20.0),
    case("scope_point_at_seconds",
         se.scope_timed_prompt_text,
         "at 25s the camera pans across the harbour",
         20.0, 30.0),
    case("scope_colon_units_clipped",
         se.scope_timed_prompt_text,
         "close conversation (1:30-2:00) by the window",
         80.0, 100.0),
    case("scope_cn_seconds_point",
         se.scope_timed_prompt_text,
         "25秒處搖鏡過碼頭",
         20.0, 30.0),
    case("scope_cn_range",
         se.scope_timed_prompt_text,
         "白天棉田(0至16秒)轉為夜間膠園(16到30秒)",
         20.0, 30.0),
    case("scope_geometry_rejected",
         se.scope_timed_prompt_text,
         "the crane pulls back from 10 to 20 degrees above the street",
         20.0, 30.0),
    case("scope_off_window_all_removed",
         se.scope_timed_prompt_text,
         "morning market bustle (0-8s) and evening lantern rows (40-60s)",
         15.0, 30.0),
    case("scope_multiline_mixed",
         se.scope_timed_prompt_text,
         "rain hardens after dusk (0-10s)\n"
         "longstatic harbour shot without any schedule\n"
         "dawn ferries unload (50-60s)",
         12.0, 24.0),
    case("scope_no_schedule_passthrough",
         se.scope_timed_prompt_text,
         "a quiet courtyard with a single lantern",
         0.0, 15.0),
    case("scope_empty_window_passthrough",
         se.scope_timed_prompt_text,
         "anything (0-30s)",
         15.0, 15.0),
    case("scope_custom_field_name",
         se.scope_timed_prompt_text,
         "daylight cotton fields (0-16s) then night rubber (16-30s)",
         18.0, 28.0, field_name="environment"),

    # ---- seeds（BigInt case，TS以字串比對）----
    case("seed_by_index", se.derive_segment_seed, 42, 0),
    case("seed_by_index_1", se.derive_segment_seed, 42, 1),
    case("seed_by_index_7", se.derive_segment_seed, 123456789, 7),

    # ---- ranges_intersect / dirty / rebase ----
    case("intersect_plain_overlap", se.ranges_intersect, 1.0, 3.0, 2.0, 5.0),
    case("intersect_touch_only", se.ranges_intersect, 1.0, 3.0, 3.0, 5.0),
    case("intersect_zero_marker_inside", se.ranges_intersect, 3.0, 3.0, 1.0, 5.0),
    case("intersect_zero_marker_outside", se.ranges_intersect, 3.0, 3.0, 5.0, 9.0),
    case("dirty_middle_only", se.dirty_segment_indexes,
         segs((0.0, 15.0), (15.0, 30.0), (30.0, 45.0)), 14.0, 16.5),
    case("dirty_swapped_range", se.dirty_segment_indexes,
         segs((0.0, 15.0), (15.0, 30.0), (30.0, 45.0)), 16.5, 14.0),
    case("dirty_zero_edit_marker", se.dirty_segment_indexes,
         segs((0.0, 15.0), (15.0, 30.0), (30.0, 45.0)), 30.0, 30.0),
    case("rebase_clamped", se.rebase_timed_rows,
         [{"start_seconds": 14.0, "end_seconds": 18.0, "text": "line"}], 15.0, 30.0),
    case("rebase_unclamped", se.rebase_timed_rows,
         [{"start_seconds": 14.0, "end_seconds": 18.0, "text": "line"}], 15.0, 30.0,
         clamp=False),
    case("rebase_disjoint_dropped", se.rebase_timed_rows,
         [{"start_seconds": 1.0, "end_seconds": 2.0}], 15.0, 30.0),

    # ---- fingerprint + cache reuse ----
    case("fingerprint_nested", se.content_fingerprint,
         {"seed": 42, "steps": 8, "prompt": "夜市場景", "nested": {"b": 1, "a": [1, 2.5, True, None]}}),
    case("reuse_keeps_matching_cache",
         se.reuse_cached_segments,
         segs((0.0, 15.0), (15.0, 30.0)),
         [{"segment_id": "shot_000000000_015000000",
           "fingerprint": "abc", "output_path": "/out/a.mp4"},
          {"segment_id": "shot_015000000_030000000",
           "fingerprint": "zzz", "output_path": "/out/stale.mp4"}]),
]

anchor = __import__("subprocess").run(
    ["git", "-C", H3STUDIO, "rev-parse", "HEAD"],
    capture_output=True, text=True, check=True).stdout.strip()

# Seed cases are >2^53 ints — JSON numbers lose precision in JS, so re-emit
# those outputs as exact decimal strings.
bigint_fns = {"derive_segment_seed", "derive_named_segment_seed"}
for row in cases:
    if row["fn"] in bigint_fns and "output" in row:
        row["output"] = str(row["output"])

out = Path("src/lib/studio/segment-fixtures/python-golden.json")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(
    {"source": "segment_engine.py", "h3studio_commit": anchor, "cases": cases},
    ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"wrote {out} with {len(cases)} cases (h3studio @ {anchor[:8]})")

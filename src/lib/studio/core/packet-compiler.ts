/** PR-3 §2：H3 Reference Packet Compiler
 * 導演意圖 → 3I+3V+3A+plot 打包餵 H3（ref2va路）或首尾圖+script（fl2va路） */

import type { DirectionLanguage } from "../shared/director-intent";
import type { ArtifactRef } from "../shared/artifact-ref";
import type { RouteDecision } from "./router-types";

export interface H3ReferencePacket {
  schemaVersion: 1;
  shotId: string;
  attemptId: string;
  buildBase: string;
  timingLedgerVersion: number;
  h3Route: "ref2va" | "fl2va" | "hybrid";
  motionSource: "rigged_motion" | "multimodal_reference" | "text_driven";

  images: PacketSlot[];
  videos: PacketSlot[];
  audios: PacketSlot[];
  plot: PlotSpec;
}

export interface PacketSlot {
  slot: string;          // image_1, video_1, audio_1...
  role: string;          // character_identity, body_motion, contact_sfx...
  artifactId?: string;
  sha256?: string;
  // fl2va 路 first/last_frame 特有
  framePosition?: "first" | "last";
}

export interface PlotSpec {
  shotTask: string;
  phases: string[];      // prepare, reach, contact, pull, settle
  contact?: {
    actors: string[];
    preferredStorySec: number;
    toleranceSec: number;
  };
  forbidden: string[];
}

export function compilePacket(
  shotId: string,
  attemptId: string,
  buildBase: string,
  decision: RouteDecision,
  intent: DirectionLanguage,
  availableArtifacts: Map<string, ArtifactRef>,
): H3ReferencePacket {
  const packets: PacketSlot[] = [];

  // Image 分配
  if (decision.selectedH3Route === "ref2va") {
    packets.push(
      { slot: "image_1", role: "character_identity" },
      { slot: "image_2", role: "world_look" },
      { slot: "image_3", role: "contact_pose" },
    );
  } else {
    packets.push(
      { slot: "first_frame", role: "start_moment", framePosition: "first" },
      { slot: "last_frame", role: "end_moment", framePosition: "last" },
    );
  }

  // Video 分配（ref2va 先有 video 槽）
  const videoSlots: PacketSlot[] = [];
  if (decision.selectedH3Route === "ref2va" || decision.selectedH3Route === "hybrid") {
    videoSlots.push(
      { slot: "video_1", role: "body_motion" },
      { slot: "video_2", role: "hand_prop_interaction" },
      { slot: "video_3", role: "camera_motion" },
    );
  }

  // Audio 分配（ref2va 先有 audio ref 槽）
  const audioSlots: PacketSlot[] = [];
  if (decision.selectedH3Route === "ref2va") {
    audioSlots.push(
      { slot: "audio_1", role: "dialogue" },
      { slot: "audio_2", role: "music_rhythm" },
      { slot: "audio_3", role: "contact_sfx" },
    );
  }

  // Plot
  const plot: PlotSpec = {
    shotTask: intent.attention?.audienceTakeaway ?? "",
    phases: intent.motionIntent
      ? ["prepare", "action", "settle"]
      : ["single_action"],
    contact: intent.contact?.required
      ? {
          actors: intent.contact.actors ?? [],
          preferredStorySec: intent.contact.preferredStorySec ?? 0,
          toleranceSec: intent.contact.toleranceSec ?? 0,
        }
      : undefined,
    forbidden: intent.deformation?.forbidden ?? [],
  };

  return {
    schemaVersion: 1,
    shotId,
    attemptId,
    buildBase,
    timingLedgerVersion: 1,
    h3Route: decision.selectedH3Route ?? "ref2va",
    motionSource: decision.motionSource ?? "text_driven",
    images: packets,
    videos: videoSlots,
    audios: audioSlots,
    plot,
  };
}

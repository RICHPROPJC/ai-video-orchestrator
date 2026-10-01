/** PR-0 §3：ArtifactRef——強類型產物引用
 * uri 唔係裸路徑；committed 先可以成為 ArtifactRef。 */

export type ArtifactKind =
  | "callsheet" | "continuity" | "board" | "portrait" | "mesh"
  | "rig" | "world_plan" | "blockout_video" | "keyframe_image"
  | "motion_clip" | "h3_video" | "audio_wav" | "timing_ledger"
  | "cut_plan" | "qc_report" | "delivery_package" | "reference_packet"
  | "procedural_asset" | "render_frame" | "motion_proof" | "manifest";

export type ArtifactAvailability = "staging" | "committed" | "missing";

export interface ArtifactRef {
  artifactId: string;
  kind: ArtifactKind;
  uri: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  schemaVersion: number;
  createdAt: string;
  availability: ArtifactAvailability;
  producer: {
    seat: string;
    capability: string;
    provider: string;
  };
  lineage: {
    jobId: string;
    attemptId: string;
    buildBase: string;
    inputArtifactIds: string[];
  };
}

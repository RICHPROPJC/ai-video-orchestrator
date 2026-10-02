/** PR-3 §3：Director Intent 完整類型——導演意圖契約
 * 唔係新席——係既有十二席共同消費嘅版本化數據。 */

export interface DirectionLanguage {
  version: 1;

  attention?: {
    primarySubject: string;
    secondarySubject?: string;
    audienceTakeaway: string;
    revealOrder: string[];
  };

  motionIntent?: {
    cause: string;
    preparation?: { durationHintSec: number; description: string };
    action: { path: string; contactTarget?: string };
    settle?: { durationHintSec: number; description: string };
    momentumContinuity: boolean;
  };

  contact?: {
    required: boolean;
    actors: string[];
    preferredStorySec: number;
    toleranceSec: number;
    enforcement: "edit_or_qc";
  };

  deformation?: {
    allowed: boolean;
    exceptions: string[];
    forbidden: string[];
  };

  cameraIntent?: {
    reason: string;
    startFraming: string;
    endFraming: string;
    pathHint: string;
    forbidden: string[];
  };

  lightingIntent?: {
    keyDirection: string;
    contactShadowRequired: boolean;
    highlightTarget?: string;
  };

  audioCues?: Array<{
    type: "sfx" | "music" | "dialogue";
    cue: string;
    storySec: number;
    toleranceSec: number;
    enforcement: "edit" | "qc";
  }>;
}

// 席位 → 佢關心嘅欄位
export const SEAT_CONSUMES: Record<string, string[]> = {
  boards: ["attention.revealOrder", "attention.primarySubject"],
  art: ["attention.primarySubject", "cameraIntent.startFraming"],
  layout: ["motionIntent.path", "motionIntent.cause", "cameraIntent.pathHint"],
  stills: ["attention.revealOrder", "cameraIntent.startFraming", "lightingIntent"],
  motion: ["contact.required", "contact.actors", "motionIntent.action.path"],
  pictureQc: ["deformation.forbidden", "attention.primarySubject"],
  voice: ["audioCues"],
  soundQc: ["audioCues"],
  editor: ["contact.preferredStorySec", "audioCues"],
};

export type Vec3 = [number, number, number];

export type PrimitiveId =
  | "cube"
  | "uv_sphere"
  | "ico_sphere"
  | "cylinder"
  | "cone"
  | "torus"
  | "plane"
  | "monkey";

export type RecipeId =
  | PrimitiveId
  | "table"
  | "pedestal"
  | "tree"
  | "character"
  | "robot"
  | "car"
  | "room"
  | "lamp"
  | "city"
  | "bowl";

export type ObjectKind = "mesh" | "light" | "camera" | "empty";

export type LightType = "POINT" | "SUN" | "SPOT" | "AREA";

export type CameraMode = "director" | "first_person" | "third_person" | "hidden";

export type CharacterAction = "idle" | "walk" | "wave" | "sit" | "look";

export type CharacterBone = "root" | "torso" | "head" | "hair" | "armL" | "armR" | "legL" | "legR" | "hip";

export type ObjectRole = "hero" | "extra" | "set" | "prop" | "hidden_cam" | "sky" | "ocean";

export type PhysicsType = "off" | "static" | "dynamic" | "character";

export type MaterialPreset =
  | "plastic"
  | "matte"
  | "glossy"
  | "rubber"
  | "clay"
  | "metal"
  | "chrome"
  | "gold"
  | "copper"
  | "silver"
  | "glass"
  | "toon"
  | "marble"
  | "wood"
  | "emissive"
  | "foliage"
  | "skin"
  | "asphalt"
  | "water"
  | "sky";

export type MaterialState = {
  preset: MaterialPreset;
  color: string;
  roughness: number;
  metalness: number;
  transmission: number;
  ior: number;
  emission: string;
  emissionStrength: number;
};

export type Appearance = {
  skin: string;
  shirt: string;
  pants: string;
  hair: string;
};

export type SceneObject = {
  id: string;
  name: string;
  kind: ObjectKind;
  primitive?: PrimitiveId;
  location: Vec3;
  rotation: Vec3;
  scale: Vec3;
  visible: boolean;
  parentId?: string;
  material?: MaterialState;
  light?: {
    type: LightType;
    energy: number;
    color: string;
    size: number;
    angle: number;
  };
  camera?: {
    fov: number;
    lookAt: Vec3;
  };
  role?: ObjectRole;
  rig?: string;
  bone?: CharacterBone;
  action?: CharacterAction;
  appearance?: Appearance;
  maskId?: number;
  holdout?: boolean;
  physics?: PhysicsType;
  path?: Vec3[];
  invert?: boolean;
};

export type WorldState = {
  color: string;
  strength: number;
  mood: "studio" | "overcast" | "night" | "sunset" | "neutral" | "day";
  fog: number;
};

export type SceneState = {
  objects: SceneObject[];
  world: WorldState;
  activeCameraId: string | null;
  selectedId: string | null;
  nextId: number;
  playback: "idle" | "turntable" | "live";
  frame: number;
  cameraMode: CameraMode;
  followName: string | null;
  physics: boolean;
};

export type ToolName =
  | "scene.clear"
  | "scene.set_world"
  | "object.create"
  | "object.transform"
  | "object.delete"
  | "object.duplicate"
  | "object.rename"
  | "object.set_material"
  | "light.create"
  | "camera.create"
  | "camera.frame"
  | "camera.mode"
  | "animation.turntable"
  | "world.build"
  | "character.spawn"
  | "character.appear"
  | "character.action"
  | "character.move"
  | "physics.set"
  | "mask.set"
  | "render.frame"
  | "render.animation"
  | "render.matte"
  | "skill.run";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ToolCall = {
  tool: ToolName;
  args: Record<string, JsonValue>;
};

export type ToolLog = {
  id: string;
  tool: string;
  args: Record<string, JsonValue>;
  ok: boolean;
  message: string;
  ms: number;
};

export type VisionIssue = {
  code: string;
  severity: "info" | "warn" | "fix";
  message: string;
};

export type ChatRole = "user" | "astra" | "system";

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  skills?: string[];
};

export type PlanResult = {
  calls: ToolCall[];
  skills: string[];
  summary: string;
  thinking: string[];
};

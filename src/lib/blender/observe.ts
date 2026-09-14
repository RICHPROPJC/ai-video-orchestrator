import { describeSpatial } from "./spatial";
import { MASK_LEGEND, rigRoot } from "./world";
import type { SceneState, ToolName } from "./types";

export type CheckResult = {
  id: string;
  ok: boolean;
  detail: string;
};

export type Observation = {
  protocol: "astra.protocol.v2";
  blender: "5.12-compatible";
  cameraMode: SceneState["cameraMode"];
  followName: string | null;
  physics: boolean;
  fog: number;
  mood: SceneState["world"]["mood"];
  hero: {
    name: string;
    location: [number, number, number];
    action: string;
    appearance?: { shirt: string; pants: string; skin: string; hair: string };
  } | null;
  counts: {
    mesh: number;
    light: number;
    camera: number;
    hiddenCam: number;
    character: number;
  };
  landmarks: string[];
  spatial: string;
  masks: { id: number; label: string; count: number }[];
  nextAllowed: ToolName[];
};

export function observe(scene: SceneState): Observation {
  const hero = rigRoot(scene, scene.followName ?? "Truman") ?? scene.objects.find((o) => o.role === "hero" && o.bone === "root");
  const meshes = scene.objects.filter((o) => o.kind === "mesh");
  const maskCounts = MASK_LEGEND.map((m) => ({
    ...m,
    count: scene.objects.filter((o) => o.maskId === m.id).length,
  }));
  return {
    protocol: "astra.protocol.v2",
    blender: "5.12-compatible",
    cameraMode: scene.cameraMode,
    followName: scene.followName,
    physics: scene.physics,
    fog: scene.world.fog,
    mood: scene.world.mood,
    hero: hero
      ? {
          name: hero.name,
          location: hero.location,
          action: hero.action ?? "idle",
          appearance: hero.appearance,
        }
      : null,
    counts: {
      mesh: meshes.length,
      light: scene.objects.filter((o) => o.kind === "light").length,
      camera: scene.objects.filter((o) => o.kind === "camera").length,
      hiddenCam: scene.objects.filter((o) => o.role === "hidden_cam" && o.kind === "camera").length,
      character: scene.objects.filter((o) => o.bone === "root").length,
    },
    landmarks: meshes
      .filter((m) => /Dome$|Ocean|Plaza|House|TownGround|Beach/.test(m.name))
      .map((m) => m.name),
    spatial: describeSpatial(scene),
    masks: maskCounts,
    nextAllowed: [
      "world.build",
      "character.spawn",
      "character.appear",
      "character.action",
      "character.move",
      "camera.mode",
      "physics.set",
      "mask.set",
      "object.create",
      "light.create",
      "camera.frame",
    ],
  };
}

export function runChecks(
  scene: SceneState,
  ids: string[],
): CheckResult[] {
  const obs = observe(scene);
  const table: Record<string, () => CheckResult> = {
    has_hero: () => ({
      id: "has_hero",
      ok: Boolean(obs.hero),
      detail: obs.hero ? `主角 ${obs.hero.name}` : "沒有主角 rig",
    }),
    has_set: () => ({
      id: "has_set",
      ok: obs.counts.mesh >= 8,
      detail: `網格 ${obs.counts.mesh}`,
    }),
    has_dome: () => ({
      id: "has_dome",
      ok: obs.landmarks.some((n) => n === "Dome"),
      detail: obs.landmarks.includes("Dome") ? "天空罩存在（開放世界其實是片場）" : "沒有天空罩",
    }),
    has_ocean: () => ({
      id: "has_ocean",
      ok: obs.landmarks.some((n) => n === "Ocean"),
      detail: obs.landmarks.includes("Ocean") ? "有海平面深度" : "沒有海",
    }),
    physics_on: () => ({
      id: "physics_on",
      ok: obs.physics,
      detail: obs.physics ? "碰撞開啟" : "物理關閉",
    }),
    camera_embodied: () => ({
      id: "camera_embodied",
      ok: obs.cameraMode === "first_person" || obs.cameraMode === "third_person" || obs.cameraMode === "hidden",
      detail: `鏡頭 ${obs.cameraMode}`,
    }),
    camera_first: () => ({
      id: "camera_first",
      ok: obs.cameraMode === "first_person",
      detail: `鏡頭 ${obs.cameraMode}`,
    }),
    camera_third: () => ({
      id: "camera_third",
      ok: obs.cameraMode === "third_person",
      detail: `鏡頭 ${obs.cameraMode}`,
    }),
    has_lights: () => ({
      id: "has_lights",
      ok: obs.counts.light > 0,
      detail: `燈 ${obs.counts.light}`,
    }),
    has_hidden_cams: () => ({
      id: "has_hidden_cams",
      ok: obs.counts.hiddenCam >= 2,
      detail: `隱藏鏡頭 ${obs.counts.hiddenCam}`,
    }),
    walking: () => ({
      id: "walking",
      ok: obs.hero?.action === "walk" || obs.hero?.action === "wave",
      detail: `動作 ${obs.hero?.action ?? "無"}`,
    }),
    fog_depth: () => ({
      id: "fog_depth",
      ok: obs.fog > 0.01,
      detail: `霧 ${obs.fog}`,
    }),
  };
  return ids.map((id) => table[id]?.() ?? { id, ok: false, detail: "未知檢查" });
}

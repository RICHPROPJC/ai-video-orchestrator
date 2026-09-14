import { materialFromPreset } from "./materials";
import type {
  Appearance,
  CharacterAction,
  CharacterBone,
  MaterialPreset,
  PrimitiveId,
  SceneObject,
  SceneState,
  Vec3,
} from "./types";

const TRUMAN_LOOK: Appearance = {
  skin: "#e8c4a8",
  shirt: "#f4f1ea",
  pants: "#c4b07a",
  hair: "#4a3424",
};

const EXTRA_LOOKS: Appearance[] = [
  { skin: "#c98b63", shirt: "#3b82f6", pants: "#1e3a5f", hair: "#1a1a1a" },
  { skin: "#f0d0b4", shirt: "#e23d3d", pants: "#2a2a2c", hair: "#7a4e2d" },
  { skin: "#d8a07a", shirt: "#f5a524", pants: "#364054", hair: "#4a3424" },
];

function add(scene: SceneState, partial: Omit<SceneObject, "id" | "visible" | "rotation" | "scale"> & Partial<SceneObject>) {
  const obj: SceneObject = {
    visible: true,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    ...partial,
    id: `obj_${scene.nextId++}`,
  };
  scene.objects.push(obj);
  return obj;
}

function mesh(
  scene: SceneState,
  name: string,
  primitive: PrimitiveId,
  location: Vec3,
  scale: Vec3,
  preset: MaterialPreset,
  color: string,
  extra: Partial<SceneObject> = {},
) {
  return add(scene, {
    name,
    kind: "mesh",
    primitive,
    location,
    scale,
    material: materialFromPreset(preset, color),
    role: extra.role ?? "set",
    physics: extra.physics ?? "static",
    maskId: extra.maskId ?? 1,
    ...extra,
  });
}

export function spawnCharacter(
  scene: SceneState,
  opts: {
    name: string;
    location: Vec3;
    role: "hero" | "extra";
    appearance?: Appearance;
    action?: CharacterAction;
    path?: Vec3[];
    yaw?: number;
  },
) {
  const look = opts.appearance ?? (opts.role === "hero" ? TRUMAN_LOOK : EXTRA_LOOKS[scene.nextId % EXTRA_LOOKS.length]);
  const [x, y] = opts.location;
  const yaw = opts.yaw ?? 0;
  const maskId = opts.role === "hero" ? 2 : 3;
  const rig = opts.name;

  add(scene, {
    name: rig,
    kind: "empty",
    location: [x, y, 0],
    rotation: [0, 0, yaw],
    role: opts.role,
    rig,
    bone: "root",
    action: opts.action ?? "idle",
    appearance: look,
    physics: "character",
    maskId,
    path: opts.path,
  });

  const parts: Array<[string, CharacterBone, PrimitiveId, Vec3, Vec3, MaterialPreset, string]> = [
    [`${rig}_Hip`, "hip", "cube", [0, 0, 0.72], [0.48, 0.26, 0.22], "plastic", look.pants],
    [`${rig}_Torso`, "torso", "cube", [0, 0, 1.16], [0.52, 0.3, 0.68], "plastic", look.shirt],
    [`${rig}_Head`, "head", "uv_sphere", [0, 0, 1.72], [0.3, 0.3, 0.3], "skin", look.skin],
    [`${rig}_Hair`, "hair", "uv_sphere", [0, 0.02, 1.86], [0.28, 0.26, 0.16], "matte", look.hair],
    [`${rig}_LegL`, "legL", "cylinder", [-0.13, 0, 0.34], [0.11, 0.11, 0.66], "plastic", look.pants],
    [`${rig}_LegR`, "legR", "cylinder", [0.13, 0, 0.34], [0.11, 0.11, 0.66], "plastic", look.pants],
    [`${rig}_ArmL`, "armL", "cylinder", [-0.4, 0, 1.18], [0.08, 0.08, 0.58], "skin", look.skin],
    [`${rig}_ArmR`, "armR", "cylinder", [0.4, 0, 1.18], [0.08, 0.08, 0.58], "skin", look.skin],
  ];

  for (const [name, bone, primitive, loc, scale, preset, color] of parts) {
    mesh(scene, name, primitive, [x + loc[0], y + loc[1], loc[2]], scale, preset, color, {
      role: opts.role,
      rig,
      bone,
      physics: "character",
      maskId,
    });
  }

  return rig;
}

function house(scene: SceneState, name: string, x: number, y: number, w: number, d: number, h: number, color: string) {
  mesh(scene, `${name}_Body`, "cube", [x, y, h / 2], [w, d, h], "matte", color, { role: "set", physics: "static", maskId: 1 });
  mesh(scene, `${name}_Roof`, "cone", [x, y, h + 0.55], [w * 0.78, d * 0.78, 1.1], "plastic", "#7a3a32", {
    role: "set",
    physics: "static",
    maskId: 1,
  });
}

export function buildWorld(scene: SceneState, preset: string): { scene: SceneState; message: string } {
  const next: SceneState = {
    ...scene,
    objects: scene.objects.filter((o) => o.kind === "camera"),
    world: { ...scene.world },
  };

  if (preset === "interior") {
    mesh(next, "RoomFloor", "plane", [0, 0, 0], [10, 10, 1], "matte", "#cfc8bc", { role: "set", physics: "static" });
    mesh(next, "WallBack", "cube", [0, 5, 2.2], [10, 0.12, 4.4], "matte", "#e8e2d6", { role: "set", physics: "static" });
    mesh(next, "WallL", "cube", [-5, 0, 2.2], [0.12, 10, 4.4], "matte", "#ddd6c8", { role: "set", physics: "static" });
    mesh(next, "WallR", "cube", [5, 0, 2.2], [0.12, 10, 4.4], "matte", "#ddd6c8", { role: "set", physics: "static" });
    spawnCharacter(next, { name: "Actor", location: [0, -1.4, 0], role: "hero", action: "idle" });
    next.world = { color: "#d7cfc4", strength: 0.4, mood: "overcast", fog: 0.01 };
    next.physics = true;
    next.followName = "Actor";
    next.cameraMode = "third_person";
    next.playback = "live";
    add(next, {
      name: "WindowSun",
      kind: "light",
      location: [2, -4, 4],
      light: { type: "SUN", energy: 3, color: "#fff1d6", size: 1, angle: 40 },
      role: "prop",
    });
    return { scene: next, message: "Interior room with an actor (third person)" };
  }

  const isTruman = preset === "truman" || preset === "open_world" || preset === "seahaven";

  mesh(next, "TownGround", "plane", [0, 0, 0], [42, 42, 1], "foliage", "#6b8f4a", { role: "set", physics: "static", maskId: 1 });
  mesh(next, "MainStreet", "plane", [0, 1, 0.02], [3.4, 28, 1], "asphalt", "#3a3d44", { role: "set", physics: "static", maskId: 1 });
  mesh(next, "CrossStreet", "plane", [0, 0, 0.021], [22, 3.2, 1], "asphalt", "#3a3d44", { role: "set", physics: "static", maskId: 1 });
  mesh(next, "Plaza", "cylinder", [0, 0, 0.04], [3.6, 3.6, 0.08], "marble", "#e6e0d4", { role: "set", physics: "static", maskId: 1 });

  house(next, "HouseNE", 6.5, 6.2, 3.2, 2.6, 2.6, "#f3ead8");
  house(next, "HouseNW", -6.5, 6.2, 3.0, 2.8, 2.4, "#f4d6c3");
  house(next, "HouseSE", 6.5, -5.4, 3.4, 2.5, 2.8, "#d7c4a5");
  house(next, "HouseSW", -6.5, -5.4, 2.8, 2.6, 2.3, "#e8e2d6");
  house(next, "HouseN", 0, 9.4, 3.6, 2.4, 2.5, "#efe6d6");

  mesh(next, "TreeA_Trunk", "cylinder", [-2.6, 3.2, 0.7], [0.18, 0.18, 1.4], "wood", "#8a5a32", { role: "set", maskId: 1 });
  mesh(next, "TreeA_Crown", "cone", [-2.6, 3.2, 1.9], [1.2, 1.2, 1.5], "foliage", "#3f8f4a", { role: "set", maskId: 1 });
  mesh(next, "TreeB_Trunk", "cylinder", [3.1, -3.4, 0.7], [0.18, 0.18, 1.4], "wood", "#8a5a32", { role: "set", maskId: 1 });
  mesh(next, "TreeB_Crown", "cone", [3.1, -3.4, 1.9], [1.2, 1.2, 1.5], "foliage", "#2f7a3c", { role: "set", maskId: 1 });

  if (isTruman) {
    mesh(next, "Ocean", "plane", [0, 18, -0.08], [48, 16, 1], "water", "#1d4f78", { role: "ocean", physics: "static", maskId: 5 });
    mesh(next, "Beach", "plane", [0, 12.5, 0.01], [20, 4, 1], "matte", "#e4d2a8", { role: "set", physics: "static", maskId: 1 });
    mesh(next, "Dome", "ico_sphere", [0, 2, 8], [26, 26, 26], "sky", "#7eb6e8", {
      role: "sky",
      physics: "static",
      maskId: 8,
      invert: true,
      holdout: false,
    });
    mesh(next, "DomeDoor", "cube", [0, 22, 3.2], [4.4, 0.4, 6.4], "metal", "#c0c7d1", { role: "set", physics: "static", maskId: 4 });
  }

  spawnCharacter(next, {
    name: "Truman",
    location: [0, -1.2, 0],
    role: "hero",
    action: "walk",
    appearance: TRUMAN_LOOK,
    path: [
      [0, -1.2, 0],
      [0, 3.4, 0],
      [2.4, 3.4, 0],
      [2.4, -1.2, 0],
    ],
  });
  spawnCharacter(next, {
    name: "ExtraA",
    location: [-4.2, 2.4, 0],
    role: "extra",
    action: "walk",
    appearance: EXTRA_LOOKS[0],
    path: [
      [-4.2, 2.4, 0],
      [-4.2, 7, 0],
      [4.2, 7, 0],
      [4.2, 2.4, 0],
    ],
  });
  spawnCharacter(next, {
    name: "ExtraB",
    location: [3.6, -3.8, 0],
    role: "extra",
    action: "walk",
    appearance: EXTRA_LOOKS[1],
    path: [
      [3.6, -3.8, 0],
      [-3.2, -3.8, 0],
      [-3.2, 1.2, 0],
      [3.6, 1.2, 0],
    ],
  });

  const cams: Array<[string, Vec3, Vec3]> = [
    ["Hidden_Roof", [6.5, 6.2, 4.2], [0, 0, 1.2]],
    ["Hidden_Plaza", [-0.4, -8.4, 2.4], [0, 0, 1]],
    ["Hidden_Beach", [4, 14, 2.8], [0, 2, 1]],
    ["Hidden_Lamp", [-6.2, 0.2, 3.6], [0, 0, 1.1]],
  ];
  for (const [name, loc, look] of cams) {
    add(next, {
      name,
      kind: "camera",
      location: loc,
      role: "hidden_cam",
      maskId: 6,
      camera: { fov: 38, lookAt: look },
    });
    mesh(next, `${name}_Body`, "cube", loc, [0.18, 0.22, 0.12], "metal", "#1a1a1a", { role: "hidden_cam", maskId: 6, physics: "off" });
  }

  add(next, {
    name: "Sun",
    kind: "light",
    location: [10, -8, 16],
    light: { type: "SUN", energy: 3.4, color: "#fff4dc", size: 1, angle: 40 },
    role: "prop",
  });
  add(next, {
    name: "SkyFill",
    kind: "light",
    location: [-8, 6, 10],
    light: { type: "AREA", energy: 90, color: "#cfe6ff", size: 6, angle: 80 },
    role: "prop",
  });

  const director = next.objects.find((o) => o.name === "Camera" && o.kind === "camera");
  if (director?.camera) {
    director.location = [11, -12, 7];
    director.camera.lookAt = [0, 1, 1.2];
    director.camera.fov = 35;
    next.activeCameraId = director.id;
  }

  next.world = {
    color: isTruman ? "#87b7e0" : "#9eb0c6",
    strength: 0.55,
    mood: "day",
    fog: isTruman ? 0.022 : 0.012,
  };
  next.physics = true;
  next.followName = "Truman";
  next.cameraMode = "third_person";
  next.playback = "live";

  return {
    scene: next,
    message: isTruman
      ? "Seahaven dome: town, ocean, sky mask, Truman, extras walking, hidden cameras"
      : "Town plaza with a hero character",
  };
}

export function rigRoot(scene: SceneState, name: string) {
  return scene.objects.find((o) => o.rig === name && o.bone === "root") ?? scene.objects.find((o) => o.name === name && o.kind === "empty");
}

export function setRigAction(scene: SceneState, name: string, action: CharacterAction) {
  for (const obj of scene.objects) {
    if (obj.rig === name || obj.name === name) obj.action = action;
  }
}

export function appearRig(scene: SceneState, name: string, appearance: Partial<Appearance>) {
  const root = rigRoot(scene, name);
  const merged = Object.fromEntries(Object.entries(appearance).filter(([, v]) => Boolean(v))) as Partial<Appearance>;
  const look: Appearance = {
    ...(root?.appearance ?? TRUMAN_LOOK),
    ...merged,
  };
  if (root) root.appearance = look;
  const paint: Record<string, [MaterialPreset, string]> = {
    torso: ["plastic", look.shirt],
    hip: ["plastic", look.pants],
    head: ["skin", look.skin],
    hair: ["matte", look.hair],
    armL: ["skin", look.skin],
    armR: ["skin", look.skin],
    legL: ["plastic", look.pants],
    legR: ["plastic", look.pants],
  };
  for (const obj of scene.objects) {
    if (obj.rig !== name || !obj.bone) continue;
    const spec = paint[obj.bone];
    if (spec) obj.material = materialFromPreset(spec[0], spec[1]);
  }
}

export function moveRig(scene: SceneState, name: string, location: Vec3, yaw?: number) {
  const root = rigRoot(scene, name);
  if (!root) return;
  const dx = location[0] - root.location[0];
  const dy = location[1] - root.location[1];
  for (const obj of scene.objects) {
    if (obj.rig !== name && obj.name !== name) continue;
    obj.location = [obj.location[0] + dx, obj.location[1] + dy, obj.location[2]];
    if (yaw !== undefined && obj.bone === "root") obj.rotation = [obj.rotation[0], obj.rotation[1], yaw];
  }
}

export function collideMove(scene: SceneState, from: Vec3, to: Vec3): Vec3 {
  if (!scene.physics) return to;
  const blockers = scene.objects.filter(
    (o) => o.kind === "mesh" && o.physics === "static" && o.primitive === "cube" && /House|Wall|Door/i.test(o.name),
  );
  for (const b of blockers) {
    const hx = b.scale[0] / 2 + 0.35;
    const hy = b.scale[1] / 2 + 0.35;
    if (Math.abs(to[0] - b.location[0]) < hx && Math.abs(to[1] - b.location[1]) < hy) {
      return from;
    }
  }
  const dome = scene.objects.find((o) => o.role === "sky");
  if (dome) {
    const r = (dome.scale[0] ?? 26) * 0.42;
    if (to[0] * to[0] + to[1] * to[1] > r * r) return from;
  }
  return [to[0], to[1], 0];
}

export type MaskLegend = { id: number; label: string };

export const MASK_LEGEND: MaskLegend[] = [
  { id: 1, label: "Set / architecture" },
  { id: 2, label: "Hero character" },
  { id: 3, label: "Extras" },
  { id: 4, label: "Dome door / seam" },
  { id: 5, label: "Ocean" },
  { id: 6, label: "Hidden cameras" },
  { id: 8, label: "Sky dome" },
];

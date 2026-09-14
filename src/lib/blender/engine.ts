import { emptyScene } from "./empty-scene";
import { materialFromPreset } from "./materials";
import { expandRecipe, isPrimitive } from "./recipes";
import { SKILLS } from "./skills";
import { appearRig, buildWorld, collideMove, moveRig, rigRoot, setRigAction, spawnCharacter } from "./world";
import type {
  CameraMode,
  CharacterAction,
  JsonValue,
  LightType,
  MaterialPreset,
  PrimitiveId,
  RecipeId,
  SceneObject,
  SceneState,
  ToolCall,
  ToolLog,
  Vec3,
} from "./types";

let logSeq = 0;

function asVec3(value: JsonValue | undefined, fallback: Vec3): Vec3 {
  if (Array.isArray(value) && value.length >= 3) {
    return [Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0];
  }
  return fallback;
}

function asString(value: JsonValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBool(value: JsonValue | undefined, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function uid(scene: SceneState, prefix: string) {
  const id = `${prefix}_${scene.nextId}`;
  scene.nextId += 1;
  return id;
}

function findByName(scene: SceneState, name: string) {
  const lower = name.toLowerCase();
  return scene.objects.find((o) => o.name.toLowerCase() === lower || o.id === name);
}

function meshes(scene: SceneState) {
  return scene.objects.filter((o) => o.kind === "mesh");
}

export function sceneBBox(scene: SceneState) {
  const items = meshes(scene);
  if (!items.length) {
    return { min: [0, 0, 0] as Vec3, max: [0, 0, 0] as Vec3, center: [0, 0, 0.5] as Vec3, size: 1 };
  }
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const o of items) {
    for (let i = 0; i < 3; i++) {
      const half = o.scale[i] * 0.5;
      min[i] = Math.min(min[i], o.location[i] - half);
      max[i] = Math.max(max[i], o.location[i] + half);
    }
  }
  const center: Vec3 = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const size = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 0.8);
  return { min, max, center, size };
}

function applyOne(scene: SceneState, call: ToolCall): { scene: SceneState; message: string } {
  const next: SceneState = {
    ...scene,
    objects: scene.objects.map((o) => ({
      ...o,
      location: [...o.location] as Vec3,
      rotation: [...o.rotation] as Vec3,
      scale: [...o.scale] as Vec3,
      material: o.material ? { ...o.material } : undefined,
      light: o.light ? { ...o.light } : undefined,
      camera: o.camera ? { ...o.camera, lookAt: [...o.camera.lookAt] as Vec3 } : undefined,
      appearance: o.appearance ? { ...o.appearance } : undefined,
      path: o.path ? o.path.map((p) => [...p] as Vec3) : undefined,
    })),
    world: { ...scene.world },
  };
  const args = call.args;

  switch (call.tool) {
    case "scene.clear": {
      const cleared = emptyScene();
      cleared.nextId = scene.nextId;
      return { scene: cleared, message: "Scene cleared" };
    }
    case "scene.set_world": {
      next.world = {
        color: asString(args.color, next.world.color),
        strength: asNumber(args.strength, next.world.strength),
        mood: (asString(args.mood, next.world.mood) as SceneState["world"]["mood"]) || next.world.mood,
        fog: asNumber(args.fog, next.world.fog),
      };
      return { scene: next, message: `World mood ${next.world.mood}` };
    }
    case "object.create": {
      const primitive = asString(args.primitive, "cube") as PrimitiveId;
      const name = asString(args.name, primitive.charAt(0).toUpperCase() + primitive.slice(1));
      const location = asVec3(args.location, [0, 0, 0.5]);
      const rotation = asVec3(args.rotation, [0, 0, 0]);
      const scale = asVec3(args.scale, [1, 1, 1]);
      const preset = (asString(args.material, "plastic") || "plastic") as MaterialPreset;
      const color = asString(args.color) || undefined;
      const obj: SceneObject = {
        id: uid(next, "obj"),
        name,
        kind: "mesh",
        primitive,
        location,
        rotation,
        scale,
        visible: true,
        material: materialFromPreset(preset, color),
      };
      next.objects.push(obj);
      next.selectedId = obj.id;
      return { scene: next, message: `Created ${name}` };
    }
    case "object.transform": {
      const target = asString(args.name) || asString(args.id) || next.selectedId || "";
      const obj = findByName(next, target) ?? next.objects.find((o) => o.id === next.selectedId);
      if (!obj) return { scene: next, message: "No object to transform" };
      if (args.location) obj.location = asVec3(args.location, obj.location);
      if (args.rotation) obj.rotation = asVec3(args.rotation, obj.rotation);
      if (args.scale) obj.scale = asVec3(args.scale, obj.scale);
      return { scene: next, message: `Transformed ${obj.name}` };
    }
    case "object.delete": {
      const target = asString(args.name) || asString(args.id);
      const before = next.objects.length;
      next.objects = next.objects.filter((o) => o.name !== target && o.id !== target);
      return { scene: next, message: `Deleted ${before - next.objects.length} object(s)` };
    }
    case "object.duplicate": {
      const target = asString(args.name) || next.selectedId || "";
      const obj = findByName(next, target);
      if (!obj) return { scene: next, message: "Nothing to duplicate" };
      const copy = {
        ...obj,
        id: uid(next, "obj"),
        name: `${obj.name}_copy`,
        location: [obj.location[0] + 1.4, obj.location[1], obj.location[2]] as Vec3,
      };
      next.objects.push(copy);
      next.selectedId = copy.id;
      return { scene: next, message: `Duplicated ${obj.name}` };
    }
    case "object.rename": {
      const obj = findByName(next, asString(args.name) || asString(args.id));
      if (!obj) return { scene: next, message: "Object not found" };
      obj.name = asString(args.newName, obj.name);
      return { scene: next, message: `Renamed to ${obj.name}` };
    }
    case "object.set_material": {
      const target = asString(args.name) || next.selectedId || "";
      const obj = findByName(next, target) ?? next.objects.find((o) => o.id === next.selectedId);
      if (!obj || obj.kind !== "mesh") return { scene: next, message: "No mesh for material" };
      const preset = (asString(args.material, obj.material?.preset || "plastic") || "plastic") as MaterialPreset;
      const color = asString(args.color) || undefined;
      obj.material = materialFromPreset(preset, color);
      return { scene: next, message: `Material ${preset} on ${obj.name}` };
    }
    case "light.create": {
      const type = (asString(args.type, "AREA") || "AREA") as LightType;
      const name = asString(args.name, type === "SUN" ? "Sun" : "Light");
      const obj: SceneObject = {
        id: uid(next, "lgt"),
        name,
        kind: "light",
        location: asVec3(args.location, [4, -3, 6]),
        rotation: asVec3(args.rotation, [0, 0, 0]),
        scale: [1, 1, 1],
        visible: true,
        light: {
          type,
          energy: asNumber(args.energy, type === "SUN" ? 3 : 250),
          color: asString(args.color, "#fff4e5"),
          size: asNumber(args.size, 1.2),
          angle: asNumber(args.angle, 45),
        },
      };
      next.objects.push(obj);
      return { scene: next, message: `Light ${name}` };
    }
    case "camera.create": {
      const name = asString(args.name, "Camera");
      const existing = next.objects.find((o) => o.kind === "camera");
      if (existing && !asBool(args.force, false)) {
        existing.location = asVec3(args.location, existing.location);
        if (existing.camera) existing.camera.lookAt = asVec3(args.lookAt, existing.camera.lookAt);
        next.activeCameraId = existing.id;
        return { scene: next, message: `Moved ${existing.name}` };
      }
      const obj: SceneObject = {
        id: uid(next, "cam"),
        name,
        kind: "camera",
        location: asVec3(args.location, [7.4, -6.8, 4.8]),
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        visible: true,
        camera: { fov: asNumber(args.fov, 42), lookAt: asVec3(args.lookAt, [0, 0, 0.6]) },
      };
      next.objects.push(obj);
      next.activeCameraId = obj.id;
      return { scene: next, message: `Camera ${name}` };
    }
    case "camera.frame": {
      const box = sceneBBox(next);
      const dist = Math.max(box.size * 1.85, 4);
      const cam =
        next.objects.find((o) => o.id === next.activeCameraId) ??
        next.objects.find((o) => o.kind === "camera");
      if (!cam || !cam.camera) return { scene: next, message: "No camera" };
      cam.location = [
        box.center[0] + dist * 0.72,
        box.center[1] - dist,
        box.center[2] + dist * 0.48,
      ];
      cam.camera.lookAt = box.center;
      return { scene: next, message: "Camera framed to selection" };
    }
    case "animation.turntable": {
      next.playback = asString(args.mode, "turntable") === "idle" ? "idle" : "turntable";
      return { scene: next, message: `Playback ${next.playback}` };
    }
    case "camera.mode": {
      const mode = asString(args.mode, "director") as CameraMode;
      next.cameraMode = ["director", "first_person", "third_person", "hidden"].includes(mode) ? mode : "director";
      if (args.follow) next.followName = asString(args.follow, next.followName ?? "Truman");
      if (!next.followName) {
        const hero = next.objects.find((o) => o.role === "hero" && o.bone === "root");
        next.followName = hero?.name ?? null;
      }
      if (next.cameraMode !== "director") next.playback = "live";
      return { scene: next, message: `Camera ${next.cameraMode}${next.followName ? ` → ${next.followName}` : ""}` };
    }
    case "world.build": {
      return buildWorld(next, asString(args.preset, "truman") || "truman");
    }
    case "character.spawn": {
      const name = asString(args.name, "Actor") || "Actor";
      const role = asString(args.role, "hero") === "extra" ? "extra" : "hero";
      spawnCharacter(next, {
        name,
        location: asVec3(args.location, [0, 0, 0]),
        role,
        action: (asString(args.action, "idle") as CharacterAction) || "idle",
        appearance: args.shirt || args.skin
          ? {
              skin: asString(args.skin, "#e8c4a8"),
              shirt: asString(args.shirt, "#f4f1ea"),
              pants: asString(args.pants, "#c4b07a"),
              hair: asString(args.hair, "#4a3424"),
            }
          : undefined,
      });
      next.followName = next.followName ?? name;
      next.playback = "live";
      return { scene: next, message: `Spawned ${name}` };
    }
    case "character.appear": {
      const name = asString(args.name, next.followName ?? "Truman") || "Truman";
      appearRig(next, name, {
        skin: args.skin ? asString(args.skin) : undefined,
        shirt: args.shirt ? asString(args.shirt) : undefined,
        pants: args.pants ? asString(args.pants) : undefined,
        hair: args.hair ? asString(args.hair) : undefined,
      });
      return { scene: next, message: `Appearance on ${name}` };
    }
    case "character.action": {
      const name = asString(args.name, next.followName ?? "Truman") || "Truman";
      const action = (asString(args.action, "walk") as CharacterAction) || "walk";
      setRigAction(next, name, action);
      next.playback = action === "idle" ? next.playback : "live";
      return { scene: next, message: `${name} → ${action}` };
    }
    case "character.move": {
      const name = asString(args.name, next.followName ?? "Truman") || "Truman";
      const root = rigRoot(next, name);
      if (!root) return { scene: next, message: `No rig ${name}` };
      const wanted = asVec3(args.location, root.location);
      const clamped = collideMove(next, root.location, wanted);
      moveRig(next, name, clamped, args.yaw ? asNumber(args.yaw, root.rotation[2]) : undefined);
      return { scene: next, message: `Moved ${name}` };
    }
    case "physics.set": {
      next.physics = asBool(args.enabled, true);
      return { scene: next, message: `Physics ${next.physics ? "on" : "off"}` };
    }
    case "mask.set": {
      const obj = findByName(next, asString(args.name) || next.selectedId || "");
      if (!obj) return { scene: next, message: "No object for mask" };
      obj.maskId = asNumber(args.id, obj.maskId ?? 1);
      obj.holdout = asBool(args.holdout, obj.holdout ?? false);
      return { scene: next, message: `Mask ${obj.maskId} on ${obj.name}` };
    }
    case "skill.run": {
      const skillId = asString(args.skill);
      const skill = SKILLS.find((s) => s.id === skillId);
      if (!skill) return { scene: next, message: `Unknown skill ${skillId}` };
      return { scene: applyCalls(next, skill.expand(args)).scene, message: `Ran skill ${skill.name}` };
    }
    default:
      return { scene: next, message: `Unknown tool ${call.tool}` };
  }
}

export function applyCalls(scene: SceneState, calls: ToolCall[]): { scene: SceneState; logs: ToolLog[] } {
  let current = scene;
  const logs: ToolLog[] = [];
  for (const call of calls) {
    const started = Date.now();
    try {
      const result = applyOne(current, call);
      current = result.scene;
      logs.push({
        id: `log_${++logSeq}`,
        tool: call.tool,
        args: call.args,
        ok: true,
        message: result.message,
        ms: Date.now() - started,
      });
    } catch (error) {
      logs.push({
        id: `log_err_${++logSeq}`,
        tool: call.tool,
        args: call.args,
        ok: false,
        message: error instanceof Error ? error.message : "Tool failed",
        ms: Date.now() - started,
      });
    }
  }
  return { scene: current, logs };
}

export function expandSubject(args: {
  recipe: RecipeId;
  name: string;
  location: Vec3;
  color?: string;
  material?: MaterialPreset;
}): ToolCall[] {
  if (isPrimitive(args.recipe)) {
    return [
      {
        tool: "object.create",
        args: {
          primitive: args.recipe,
          name: args.name,
          location: args.location,
          material: args.material ?? "plastic",
          ...(args.color ? { color: args.color } : {}),
        },
      },
    ];
  }
  return expandRecipe(args);
}

export const TOOL_CATALOG: {
  name: ToolCall["tool"];
  summary: string;
  blender: string;
}[] = [
  { name: "scene.clear", summary: "Reset to an empty scene with a default camera", blender: "bpy.ops.object.select_all + delete" },
  { name: "scene.set_world", summary: "World color, strength, and mood", blender: "bpy.context.scene.world" },
  { name: "object.create", summary: "Spawn a primitive mesh with material", blender: "bpy.ops.mesh.primitive_*" },
  { name: "object.transform", summary: "Set location, rotation, scale", blender: "obj.location / rotation_euler / scale" },
  { name: "object.delete", summary: "Delete by name or id", blender: "bpy.data.objects.remove" },
  { name: "object.duplicate", summary: "Duplicate the target mesh", blender: "obj.copy()" },
  { name: "object.rename", summary: "Rename a datablock", blender: "obj.name =" },
  { name: "object.set_material", summary: "Assign a lookdev preset", blender: "Principled BSDF values" },
  { name: "light.create", summary: "Add POINT, SUN, SPOT, or AREA light", blender: "bpy.ops.object.light_add" },
  { name: "camera.create", summary: "Add or move the active camera", blender: "bpy.ops.object.camera_add" },
  { name: "camera.frame", summary: "Frame meshes like view3d.camera_to_view_selected", blender: "bpy.ops.view3d.camera_to_view_selected" },
  { name: "camera.mode", summary: "Director / first person / third person / hidden cameras", blender: "camera parent to head or chase empty" },
  { name: "animation.turntable", summary: "Orbit playback for lookdev", blender: "camera orbit keyframes" },
  { name: "world.build", summary: "Build a town, interior, or Truman-style dome world", blender: "mesh primitives + world + cameras" },
  { name: "character.spawn", summary: "Spawn a rigged-looking character with appearance", blender: "parented mesh blocks + pass index" },
  { name: "character.appear", summary: "Recolor shirt, pants, skin, hair", blender: "Principled base color on named parts" },
  { name: "character.action", summary: "idle / walk / wave / sit / look", blender: "NLA / keyframes on the rig empty" },
  { name: "character.move", summary: "Walk a character with physics collision", blender: "root location + rigid body" },
  { name: "physics.set", summary: "Enable gravity and blockers", blender: "rigidbody.world_add" },
  { name: "mask.set", summary: "Cryptomatte-style pass index / holdout", blender: "obj.pass_index + holdout" },
  { name: "skill.run", summary: "Run an authored multi-tool skill", blender: "Astra skill expander" },
];

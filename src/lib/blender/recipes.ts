import { materialFromPreset } from "./materials";
import type {
  JsonValue,
  MaterialPreset,
  PrimitiveId,
  RecipeId,
  SceneObject,
  ToolCall,
  Vec3,
} from "./types";

function v(x: number, y: number, z: number): Vec3 {
  return [x, y, z];
}

function createCall(
  primitive: PrimitiveId,
  name: string,
  loc: Vec3,
  scale: Vec3,
  material: MaterialPreset,
  color?: string,
  extra?: Record<string, JsonValue>,
): ToolCall {
  return {
    tool: "object.create",
    args: {
      primitive,
      name,
      location: loc,
      scale,
      material,
      ...(color ? { color } : {}),
      ...extra,
    },
  };
}

export type RecipeRequest = {
  recipe: RecipeId;
  name: string;
  location: Vec3;
  color?: string;
  material?: MaterialPreset;
};

export function expandRecipe(req: RecipeRequest): ToolCall[] {
  const [x, y] = req.location;
  const mat = req.material;
  const color = req.color;
  const n = req.name;

  switch (req.recipe) {
    case "cube":
    case "uv_sphere":
    case "ico_sphere":
    case "cylinder":
    case "cone":
    case "torus":
    case "plane":
    case "monkey":
      return [
        createCall(
          req.recipe,
          n,
          req.recipe === "plane" ? v(x, y, 0) : req.location,
          req.recipe === "plane" ? v(8, 8, 1) : v(1, 1, 1),
          mat ?? (req.recipe === "plane" ? "matte" : "plastic"),
          color,
        ),
      ];
    case "table":
      return [
        createCall("cube", n, v(x, y, 0.72), v(2.6, 1.4, 0.08), mat ?? "wood", color),
        createCall("cube", `${n}_LegA`, v(x - 1.1, y - 0.55, 0.34), v(0.1, 0.1, 0.68), "wood"),
        createCall("cube", `${n}_LegB`, v(x + 1.1, y - 0.55, 0.34), v(0.1, 0.1, 0.68), "wood"),
        createCall("cube", `${n}_LegC`, v(x - 1.1, y + 0.55, 0.34), v(0.1, 0.1, 0.68), "wood"),
        createCall("cube", `${n}_LegD`, v(x + 1.1, y + 0.55, 0.34), v(0.1, 0.1, 0.68), "wood"),
      ];
    case "pedestal":
      return [
        createCall("cylinder", n, v(x, y, 0.45), v(0.7, 0.7, 0.9), mat ?? "marble", color),
      ];
    case "tree":
      return [
        createCall("cylinder", `${n}_Trunk`, v(x, y, 0.7), v(0.18, 0.18, 1.4), "wood"),
        createCall("cone", `${n}_Crown`, v(x, y, 1.85), v(1.3, 1.3, 1.6), "foliage", color),
      ];
    case "character":
      return [
        createCall("cube", `${n}_Torso`, v(x, y, 1.15), v(0.55, 0.32, 0.7), mat ?? "clay", color),
        createCall("uv_sphere", `${n}_Head`, v(x, y, 1.72), v(0.32, 0.32, 0.32), mat ?? "clay", color),
        createCall("cube", `${n}_Hip`, v(x, y, 0.72), v(0.5, 0.28, 0.22), mat ?? "clay", color),
        createCall("cylinder", `${n}_LegL`, v(x - 0.14, y, 0.34), v(0.12, 0.12, 0.68), mat ?? "clay", color),
        createCall("cylinder", `${n}_LegR`, v(x + 0.14, y, 0.34), v(0.12, 0.12, 0.68), mat ?? "clay", color),
        createCall("cylinder", `${n}_ArmL`, v(x - 0.42, y, 1.2), v(0.09, 0.09, 0.62), mat ?? "clay", color),
        createCall("cylinder", `${n}_ArmR`, v(x + 0.42, y, 1.2), v(0.09, 0.09, 0.62), mat ?? "clay", color),
      ];
    case "robot":
      return [
        createCall("cube", `${n}_Body`, v(x, y, 1.0), v(0.8, 0.5, 0.9), mat ?? "metal", color),
        createCall("cube", `${n}_Head`, v(x, y, 1.7), v(0.55, 0.45, 0.45), mat ?? "metal", color),
        createCall("cylinder", `${n}_Antenna`, v(x, y, 2.1), v(0.05, 0.05, 0.4), "metal"),
        createCall("uv_sphere", `${n}_EyeL`, v(x - 0.14, y - 0.24, 1.72), v(0.1, 0.1, 0.1), "emissive", "#7ecbff"),
        createCall("uv_sphere", `${n}_EyeR`, v(x + 0.14, y - 0.24, 1.72), v(0.1, 0.1, 0.1), "emissive", "#7ecbff"),
        createCall("cube", `${n}_LegL`, v(x - 0.22, y, 0.4), v(0.22, 0.28, 0.8), "metal"),
        createCall("cube", `${n}_LegR`, v(x + 0.22, y, 0.4), v(0.22, 0.28, 0.8), "metal"),
      ];
    case "car":
      return [
        createCall("cube", `${n}_Body`, v(x, y, 0.55), v(1.8, 0.9, 0.45), mat ?? "glossy", color ?? "#3b82f6"),
        createCall("cube", `${n}_Cabin`, v(x - 0.15, y, 0.95), v(0.9, 0.82, 0.38), "glass"),
        createCall("cylinder", `${n}_WheelFL`, v(x + 0.55, y - 0.5, 0.22), v(0.22, 0.22, 0.14), "rubber"),
        createCall("cylinder", `${n}_WheelFR`, v(x + 0.55, y + 0.5, 0.22), v(0.22, 0.22, 0.14), "rubber"),
        createCall("cylinder", `${n}_WheelRL`, v(x - 0.55, y - 0.5, 0.22), v(0.22, 0.22, 0.14), "rubber"),
        createCall("cylinder", `${n}_WheelRR`, v(x - 0.55, y + 0.5, 0.22), v(0.22, 0.22, 0.14), "rubber"),
      ];
    case "room":
      return [
        createCall("plane", `${n}_Floor`, v(x, y, 0), v(10, 10, 1), "matte", color ?? "#cfc8bc"),
        createCall("cube", `${n}_WallBack`, v(x, y + 5, 2.2), v(10, 0.12, 4.4), "matte", "#e8e2d6"),
        createCall("cube", `${n}_WallL`, v(x - 5, y, 2.2), v(0.12, 10, 4.4), "matte", "#ddd6c8"),
        createCall("cube", `${n}_WallR`, v(x + 5, y, 2.2), v(0.12, 10, 4.4), "matte", "#ddd6c8"),
      ];
    case "lamp":
      return [
        createCall("cylinder", `${n}_Pole`, v(x, y, 0.9), v(0.08, 0.08, 1.8), "metal"),
        createCall("uv_sphere", `${n}_Bulb`, v(x, y, 1.9), v(0.28, 0.28, 0.28), "emissive", color ?? "#ffe6b0"),
      ];
    case "city":
      return [0, 1, 2, 3, 4, 5, 6, 7].map((i) => {
        const gx = x + (i % 4) * 1.6 - 2.4;
        const gy = y + Math.floor(i / 4) * 1.8 - 0.9;
        const h = 1.2 + ((i * 17) % 5) * 0.55;
        return createCall(
          "cube",
          `${n}_B${i}`,
          v(gx, gy, h / 2),
          v(1.1, 1.1, h),
          mat ?? "toon",
          color,
        );
      });
    case "bowl":
      return [
        createCall("uv_sphere", n, v(x, y, 0.35), v(0.9, 0.9, 0.45), mat ?? "glossy", color),
      ];
    default:
      return [createCall("cube", n, req.location, v(1, 1, 1), mat ?? "plastic", color)];
  }
}

export function groundZForPrimitive(primitive: PrimitiveId, scaleZ: number): number {
  if (primitive === "plane") return 0;
  if (primitive === "torus") return scaleZ * 0.35;
  return scaleZ / 2;
}

export const RECIPE_WORDS: { id: RecipeId; words: string[] }[] = [
  { id: "character", words: ["character", "person", "human", "mannequin", "figure", "actor", "人物", "角色"] },
  { id: "robot", words: ["robot", "android", "mech", "droid"] },
  { id: "city", words: ["city", "skyline", "buildings", "cityblock", "city block"] },
  { id: "room", words: ["room", "interior", "archviz", "apartment"] },
  { id: "pedestal", words: ["pedestal", "plinth", "stand"] },
  { id: "table", words: ["table", "desk"] },
  { id: "tree", words: ["trees", "tree", "pine"] },
  { id: "car", words: ["car", "vehicle", "automobile"] },
  { id: "lamp", words: ["lamp", "lantern"] },
  { id: "bowl", words: ["bowl", "dish"] },
  { id: "monkey", words: ["monkey", "suzanne", "ape"] },
  { id: "ico_sphere", words: ["ico sphere", "icosphere", "lowpoly sphere"] },
  { id: "uv_sphere", words: ["spheres", "sphere", "ball", "orb", "globe"] },
  { id: "cylinder", words: ["cylinders", "cylinder", "pipe", "column", "tube"] },
  { id: "cone", words: ["cones", "cone", "pyramid"] },
  { id: "torus", words: ["torus", "donut", "doughnut", "ring"] },
  { id: "plane", words: ["ground", "floor", "plane", "grass"] },
  { id: "cube", words: ["cubes", "cube", "box", "boxes", "crate", "block"] },
];

export function isPrimitive(id: RecipeId): id is PrimitiveId {
  return [
    "cube",
    "uv_sphere",
    "ico_sphere",
    "cylinder",
    "cone",
    "torus",
    "plane",
    "monkey",
  ].includes(id);
}

export function cloneObject(obj: SceneObject, id: string, name: string): SceneObject {
  return {
    ...obj,
    id,
    name,
    location: [...obj.location],
    rotation: [...obj.rotation],
    scale: [...obj.scale],
    material: obj.material ? { ...obj.material } : undefined,
    light: obj.light ? { ...obj.light } : undefined,
    camera: obj.camera ? { ...obj.camera, lookAt: [...obj.camera.lookAt] } : undefined,
  };
}

export { materialFromPreset };

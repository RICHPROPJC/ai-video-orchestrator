import type { JsonValue, ToolCall } from "./types";

export type Skill = {
  id: string;
  name: string;
  description: string;
  category: "lookdev" | "lighting" | "camera" | "layout" | "animation" | "scene";
  triggers: string[];
  expand: (params: Record<string, JsonValue>) => ToolCall[];
};

function light(
  name: string,
  type: string,
  location: [number, number, number],
  energy: number,
  color: string,
): ToolCall {
  return {
    tool: "light.create",
    args: { name, type, location, energy, color },
  };
}

function call(tool: ToolCall["tool"], args: Record<string, JsonValue> = {}): ToolCall {
  return { tool, args };
}

export const SKILLS: Skill[] = [
  {
    id: "three_point_lighting",
    name: "Three-point lighting",
    description: "Key, fill, and rim lights — the default cinematic setup.",
    category: "lighting",
    triggers: ["three point", "three-point", "3 point", "key fill rim"],
    expand: () => [
      light("Key", "AREA", [4.2, -3.4, 5.6], 420, "#fff3dd"),
      light("Fill", "AREA", [-3.8, -2.2, 3.4], 140, "#d7e7ff"),
      light("Rim", "AREA", [0.2, 4.6, 4.8], 220, "#fff7f0"),
    ],
  },
  {
    id: "studio_soft",
    name: "Soft studio",
    description: "Large area lights and a dim world for product shots.",
    category: "lighting",
    triggers: ["studio lighting", "soft studio", "product light", "studio light"],
    expand: () => [
      { tool: "scene.set_world", args: { mood: "studio", color: "#0c0d12", strength: 0.18 } },
      light("SoftKey", "AREA", [3.6, -4.2, 6.2], 380, "#fff7ea"),
      light("SoftFill", "AREA", [-4.4, -1.4, 3.8], 110, "#e8f0ff"),
      light("Top", "AREA", [0, 0, 7.5], 90, "#ffffff"),
    ],
  },
  {
    id: "overcast",
    name: "Overcast",
    description: "High ambient, low contrast — good for clay and architecture.",
    category: "lighting",
    triggers: ["overcast", "cloudy", "soft daylight"],
    expand: () => [
      { tool: "scene.set_world", args: { mood: "overcast", color: "#9eb0c6", strength: 0.55 } },
      light("Sky", "SUN", [2, -4, 8], 2.2, "#e9f1ff"),
    ],
  },
  {
    id: "night_neon",
    name: "Night neon",
    description: "Dark world with cyan and magenta practicals.",
    category: "lighting",
    triggers: ["neon", "night", "cyber", "synthwave"],
    expand: () => [
      { tool: "scene.set_world", args: { mood: "night", color: "#05060c", strength: 0.08 } },
      light("Cyan", "AREA", [-3.2, -2, 2.4], 260, "#3ec6e0"),
      light("Magenta", "AREA", [3.4, 1.6, 2.2], 240, "#d946ef"),
      light("Moon", "SUN", [-6, 3, 9], 1.1, "#9bb7ff"),
    ],
  },
  {
    id: "sunset_rim",
    name: "Sunset rim",
    description: "Warm key from the side, cool fill, strong rim.",
    category: "lighting",
    triggers: ["sunset", "golden hour", "warm light", "dramatic"],
    expand: () => [
      { tool: "scene.set_world", args: { mood: "sunset", color: "#24160e", strength: 0.22 } },
      light("SunKey", "SUN", [6, -2, 4], 4.2, "#ffb067"),
      light("CoolFill", "AREA", [-4, -3, 2.4], 80, "#8fb4ff"),
      light("Rim", "AREA", [1, 5, 3.2], 180, "#ffd0a0"),
    ],
  },
  {
    id: "cinematic_camera",
    name: "Cinematic camera",
    description: "Low three-quarter camera with a 35–40mm feel.",
    category: "camera",
    triggers: ["cinematic camera", "film camera", "hero camera"],
    expand: () => [
      call("camera.create", { location: [6.4, -7.8, 2.6], lookAt: [0, 0, 0.9], fov: 35 }),
    ],
  },
  {
    id: "product_camera",
    name: "Product camera",
    description: "High three-quarter product angle, then frame.",
    category: "camera",
    triggers: ["product camera", "catalog camera"],
    expand: () => [
      call("camera.create", { location: [5.6, -5.8, 4.2], lookAt: [0, 0, 0.7], fov: 40 }),
      call("camera.frame"),
    ],
  },
  {
    id: "turntable",
    name: "Turntable",
    description: "Orbit the scene for lookdev review.",
    category: "animation",
    triggers: ["turntable", "orbit", "spin the camera"],
    expand: () => [call("animation.turntable", { mode: "turntable" })],
  },
  {
    id: "clay_preview",
    name: "Clay preview",
    description: "Matte clay material on the selected look — lighting stays.",
    category: "lookdev",
    triggers: ["clay preview", "clay render", "clay mode"],
    expand: () => [call("object.set_material", { material: "clay", color: "#d5c4ae" })],
  },
  {
    id: "truman_world",
    name: "Truman / Seahaven",
    description: "Dome town, ocean, sky mask, hero, walking extras, hidden cameras — an open world that is still a set.",
    category: "scene",
    triggers: [
      "truman",
      "seahaven",
      "open world",
      "open-world",
      "楚門",
      "楚门",
      "開放式世界",
      "开放世界",
    ],
    expand: () => [call("world.build", { preset: "truman" })],
  },
  {
    id: "town_plaza",
    name: "Town plaza",
    description: "A walkable plaza with houses and a hero, no dome.",
    category: "scene",
    triggers: ["plaza", "小鎮", "小镇", "場景", "场景"],
    expand: () => [call("world.build", { preset: "plaza" })],
  },
  {
    id: "interior_room",
    name: "Interior",
    description: "Four walls, an actor, third-person camera.",
    category: "scene",
    triggers: ["interior set", "indoor scene"],
    expand: () => [call("world.build", { preset: "interior" })],
  },
  {
    id: "first_person",
    name: "First person",
    description: "Camera on the character’s head — 人物第一視角.",
    category: "camera",
    triggers: ["first person", "first-person", "fps", "第一視角", "第一人称", "第一人稱"],
    expand: () => [call("camera.mode", { mode: "first_person" })],
  },
  {
    id: "third_person",
    name: "Third person",
    description: "Chase camera behind the character — 第三視覺.",
    category: "camera",
    triggers: ["third person", "third-person", "over shoulder", "第三視", "第三人称", "第三人稱"],
    expand: () => [call("camera.mode", { mode: "third_person" })],
  },
  {
    id: "hidden_cameras",
    name: "Hidden cameras",
    description: "Cut to the Truman-show surveillance grid.",
    category: "camera",
    triggers: ["hidden camera", "surveillance", "隱藏鏡頭", "隐藏镜头"],
    expand: () => [call("camera.mode", { mode: "hidden" })],
  },
  {
    id: "walk_cycle",
    name: "Walk",
    description: "Play a walk action on the followed character.",
    category: "animation",
    triggers: ["walk", "走路", "走動", "走动", "移動", "移动"],
    expand: () => [call("character.action", { action: "walk" }), call("camera.mode", { mode: "third_person" })],
  },
  {
    id: "wave_action",
    name: "Wave",
    description: "Character waves — a readable action beat.",
    category: "animation",
    triggers: ["wave", "揮手", "挥手"],
    expand: () => [call("character.action", { action: "wave" })],
  },
  {
    id: "studio_ground",
    name: "Studio ground",
    description: "Infinite-feeling studio floor.",
    category: "layout",
    triggers: ["studio ground", "cyclorama", "cyc"],
    expand: () => [
      call("object.create", {
        primitive: "plane",
        name: "StudioGround",
        location: [0, 0, 0],
        scale: [14, 14, 1],
        material: "matte",
        color: "#1a1c22",
      }),
    ],
  },
  {
    id: "marble_plinth",
    name: "Marble plinth",
    description: "A short marble cylinder to park a hero object on.",
    category: "layout",
    triggers: ["plinth", "marble pedestal", "marble stand"],
    expand: () => [
      call("object.create", {
        primitive: "cylinder",
        name: "Plinth",
        location: [0, 0, 0.28],
        scale: [1.1, 1.1, 0.56],
        material: "marble",
      }),
    ],
  },
];

export function skillById(id: string) {
  return SKILLS.find((s) => s.id === id);
}

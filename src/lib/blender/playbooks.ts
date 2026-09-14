import type { ToolCall } from "./types";

export type Playbook = {
  id: string;
  version: string;
  title: string;
  titleZh: string;
  why: string;
  intents: string[];
  steps: ToolCall[];
  checks: string[];
};

function mention(text: string, keys: string[]) {
  return keys.some((k) => text.includes(k));
}

/** Frozen playbooks. A small model only picks an id — it does not invent bpy. */
export const PLAYBOOKS: Playbook[] = [
  {
    id: "pb.seahaven.v2",
    version: "2.1.0",
    title: "Seahaven dome world",
    titleZh: "楚門小鎮（片場偽裝成開放世界）",
    why: "先建世界與物理，再掛身體鏡頭。小模型禁止先寫 bpy。",
    intents: ["truman", "seahaven", "open world", "楚門", "楚门", "開放式世界", "开放世界", "開放世界"],
    steps: [],
    checks: ["has_set", "has_hero", "has_dome", "has_ocean", "physics_on", "camera_embodied", "has_hidden_cams", "fog_depth"],
  },
  {
    id: "pb.plaza.v2",
    version: "2.1.0",
    title: "Walkable plaza",
    titleZh: "可行走廣場",
    why: "沒有圓頂時的場景底板：房子 + 主角 + 第三人稱。",
    intents: ["plaza", "小鎮", "小镇", "場景", "场景"],
    steps: [{ tool: "world.build", args: { preset: "plaza" } }],
    checks: ["has_set", "has_hero", "camera_embodied"],
  },
  {
    id: "pb.interior.v2",
    version: "2.1.0",
    title: "Interior actor",
    titleZh: "室內人物",
    why: "四面牆給空間深度，鏡頭跟著演員。",
    intents: ["interior", "室內", "室内"],
    steps: [{ tool: "world.build", args: { preset: "interior" } }],
    checks: ["has_set", "has_hero", "camera_embodied"],
  },
  {
    id: "pb.product.v2",
    version: "2.1.0",
    title: "Studio product shot",
    titleZh: "棚拍產品",
    why: "燈光與地面先於主體，再 frame。",
    intents: ["product", "studio", "chrome", "torus", "產品", "棚拍"],
    steps: [],
    checks: ["has_lights", "has_set"],
  },
  {
    id: "pb.character.v2",
    version: "2.1.0",
    title: "Character appearance + action",
    titleZh: "人物外形與動作",
    why: "生成 rig，再改衣服，再播動作。不要拆成散裝 cube。",
    intents: ["character", "人物", "外形", "揮手", "wave", "走路"],
    steps: [],
    checks: ["has_hero"],
  },
];

export function pickPlaybook(prompt: string): Playbook | null {
  const text = prompt.toLowerCase();
  const raw = prompt;
  const scored = PLAYBOOKS.map((pb) => ({
    pb,
    n: pb.intents.filter((i) => raw.includes(i) || text.includes(i.toLowerCase())).length,
  }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  return scored[0]?.pb ?? null;
}

export function stepsForPrompt(prompt: string, playbook: Playbook): ToolCall[] {
  const text = prompt.toLowerCase();
  if (playbook.id === "pb.seahaven.v2") {
    const cam = mention(prompt, ["第一視角", "第一人称", "第一人稱", "first person", "fps"])
      ? "first_person"
      : mention(prompt, ["隱藏", "hidden"])
        ? "hidden"
        : "third_person";
    const action = mention(prompt, ["揮手", "wave"]) ? "wave" : "walk";
    return [
      { tool: "world.build", args: { preset: "truman" } },
      { tool: "camera.mode", args: { mode: cam, follow: "Truman" } },
      { tool: "character.action", args: { name: "Truman", action } },
      { tool: "physics.set", args: { enabled: true } },
    ];
  }
  if (playbook.id === "pb.character.v2") {
    const shirt = mention(text, ["blue", "藍"]) ? "#3b82f6" : mention(text, ["red", "紅"]) ? "#e23d3d" : "#f4f1ea";
    const action = mention(prompt, ["揮手", "wave"]) ? "wave" : "walk";
    return [
      { tool: "character.spawn", args: { name: "Actor", role: "hero", shirt } },
      { tool: "character.appear", args: { name: "Actor", shirt } },
      { tool: "character.action", args: { name: "Actor", action } },
      { tool: "camera.mode", args: { mode: "third_person", follow: "Actor" } },
    ];
  }
  if (playbook.id === "pb.product.v2") {
    return [
      { tool: "scene.clear", args: {} },
      {
        tool: "object.create",
        args: { primitive: "cylinder", name: "Plinth", location: [0, 0, 0.28], scale: [1.1, 1.1, 0.56], material: "marble" },
      },
      {
        tool: "object.create",
        args: { primitive: "torus", name: "Hero", location: [0, 0, 1.05], material: "chrome" },
      },
      { tool: "skill.run", args: { skill: "studio_soft" } },
      { tool: "camera.frame", args: {} },
    ];
  }
  return playbook.steps;
}

export const PROTOCOL = {
  id: "astra.protocol.v2",
  version: "2.1.0",
  blender: "4.2–5.12",
  ruleZh:
    "小模型不准寫 bpy。只准選 playbook id，執行 steps，讀 observation JSON，跑 checks。失敗則只重跑失敗那一步，不准改協議。",
  versions: [
    { id: "v1.0", note: "產品棚拍：typed tools + 燈光技能" },
    { id: "v1.1", note: "Blender 5.12 插件與模擬器對齊" },
    { id: "v2.0", note: "人物 / 場景 / 第一第三人稱 / 物理 / 遮罩" },
    { id: "v2.1", note: "凍結劇本 + 觀察 JSON + 驗收檢查（給小模型用）" },
  ],
};

import { COLOR_WORDS, MATERIAL_WORDS } from "./materials";
import type { MaterialPreset } from "./types";
import { SKILLS } from "./skills";
import { RECIPE_WORDS, expandRecipe, isPrimitive } from "./recipes";
import { sceneBBox } from "./engine";
import { describeSpatial } from "./spatial";
import type { PlanResult, RecipeId, SceneState, ToolCall, Vec3 } from "./types";

type Subject = {
  recipe: RecipeId;
  color?: string;
  material?: MaterialPreset;
  name: string;
};

const COUNTS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

function titleCase(id: string) {
  return id
    .split(/[_-]/)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function extractSubjects(lower: string): Subject[] {
  const found: Subject[] = [];
  const usedSpans: Array<[number, number]> = [];

  const colorKeys = Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length);
  const matKeys = Object.keys(MATERIAL_WORDS).sort((a, b) => b.length - a.length);

  for (const entry of RECIPE_WORDS) {
    for (const word of entry.words) {
      const re = new RegExp(
        `\\b(\\d+|a|an|one|two|three|four|five)?\\s*([a-z]+)?\\s*([a-z]+)?\\s*${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "g",
      );
      let match: RegExpExecArray | null;
      while ((match = re.exec(lower))) {
        const start = match.index;
        const end = start + match[0].length;
        if (usedSpans.some(([a, b]) => start < b && end > a)) continue;
        usedSpans.push([start, end]);
        const qtyToken = match[1]?.trim();
        const count = qtyToken && COUNTS[qtyToken] ? COUNTS[qtyToken] : qtyToken && /^\d+$/.test(qtyToken) ? Number(qtyToken) : 1;
        const maybeA = match[2];
        const maybeB = match[3];
        let color: string | undefined;
        let material: MaterialPreset | undefined;
        for (const token of [maybeA, maybeB]) {
          if (!token) continue;
          if (!color && COLOR_WORDS[token]) color = COLOR_WORDS[token];
          if (!material && MATERIAL_WORDS[token]) material = MATERIAL_WORDS[token];
        }
        // Also scan nearby window for color/material words not captured
        const window = lower.slice(Math.max(0, start - 24), end + 8);
        for (const key of colorKeys) {
          if (!color && window.includes(key)) color = COLOR_WORDS[key];
        }
        for (const key of matKeys) {
          if (!material && new RegExp(`\\b${key}\\b`).test(window)) material = MATERIAL_WORDS[key];
        }
        const n = Math.min(Math.max(count, 1), 6);
        for (let i = 0; i < n; i++) {
          found.push({
            recipe: entry.id,
            color,
            material,
            name: n > 1 ? `${titleCase(entry.id)}_${i + 1}` : titleCase(entry.id),
          });
        }
      }
    }
  }
  return found;
}

function slotForIndex(index: number, total: number): Vec3 {
  if (total <= 1) return [0, 0, 0];
  const spacing = 2.1;
  const origin = -((total - 1) * spacing) / 2;
  return [origin + index * spacing, 0, 0];
}

function mention(lower: string, needles: string[]) {
  return needles.some((n) => lower.includes(n));
}

export function planPrompt(prompt: string, scene: SceneState): PlanResult {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const thinking: string[] = [];
  const calls: ToolCall[] = [];
  const skills: string[] = [];
  const meshCount = scene.objects.filter((o) => o.kind === "mesh").length;

  const wantsClear = mention(lower, ["clear", "reset", "new scene", "empty the scene", "start over", "rebuild", "清空"]);
  const additive = mention(lower, ["add ", "also ", "another", "plus ", "再加", "加上"]) && !wantsClear;
  const compose = !additive && (meshCount === 0 || mention(lower, ["make", "create", "build", "scene", "shot", "setup", "場景", "场景", "世界"]));

  const isTruman = mention(lower, ["truman", "seahaven", "open world", "open-world", "楚門", "楚门", "開放式世界", "开放世界", "開放世界"]);
  const isTown = mention(lower, ["plaza", "小鎮", "小镇"]) && !isTruman;
  const isInterior = mention(lower, ["interior set", "indoor scene", "室內", "室内"]) && !isTruman;

  if (wantsClear && !isTruman && !isTown) {
    calls.push({ tool: "scene.clear", args: {} });
    thinking.push("Reset the scene before composing.");
  }

  if (isTruman || isTown || isInterior) {
    const preset = isTruman ? "truman" : isInterior ? "interior" : "plaza";
    calls.push({ tool: "world.build", args: { preset } });
    skills.push(isTruman ? "truman_world" : isInterior ? "interior_room" : "town_plaza");
    thinking.push(
      isTruman
        ? "Building a Truman-style dome world: town, ocean, sky mask, characters, hidden cameras, physics."
        : `Building world preset “${preset}”.`,
    );

    if (mention(lower, ["first person", "first-person", "fps", "第一視角", "第一人称", "第一人稱"])) {
      calls.push({ tool: "camera.mode", args: { mode: "first_person", follow: "Truman" } });
      skills.push("first_person");
      thinking.push("First-person camera on the hero head.");
    } else if (mention(lower, ["hidden camera", "surveillance", "隱藏", "隐藏镜头"])) {
      calls.push({ tool: "camera.mode", args: { mode: "hidden" } });
      skills.push("hidden_cameras");
    } else if (mention(lower, ["director", "cinematic", "電影鏡頭"])) {
      calls.push({ tool: "camera.mode", args: { mode: "director" } });
    } else {
      calls.push({ tool: "camera.mode", args: { mode: "third_person", follow: "Truman" } });
      skills.push("third_person");
    }

    if (mention(lower, ["wave", "揮手", "挥手"])) {
      calls.push({ tool: "character.action", args: { name: "Truman", action: "wave" } });
    } else if (mention(lower, ["walk", "走路", "走動", "移动", "移動"])) {
      calls.push({ tool: "character.action", args: { name: "Truman", action: "walk" } });
    }

    const shirtColor = pickColor(lower);
    if (shirtColor && mention(lower, ["shirt", "衫", "外形", "衣服"])) {
      calls.push({ tool: "character.appear", args: { name: "Truman", shirt: shirtColor } });
      thinking.push("Applied a shirt color to the hero.");
    }

    return {
      calls,
      skills,
      summary: summarize(text, skills, 1),
      thinking,
    };
  }

  if (mention(lower, ["first person", "first-person", "fps", "第一視角", "第一人称", "第一人稱"])) {
    if (meshCount === 0) {
      calls.push({ tool: "world.build", args: { preset: "plaza" } });
      skills.push("town_plaza");
    }
    calls.push({ tool: "camera.mode", args: { mode: "first_person" } });
    skills.push("first_person");
  }
  if (mention(lower, ["third person", "third-person", "第三視", "第三人称", "第三人稱"])) {
    if (meshCount === 0 && !calls.some((c) => c.tool === "world.build")) {
      calls.push({ tool: "world.build", args: { preset: "plaza" } });
    }
    calls.push({ tool: "camera.mode", args: { mode: "third_person" } });
    skills.push("third_person");
  }
  if (mention(lower, ["hidden camera", "surveillance", "隱藏鏡頭", "隐藏镜头"])) {
    calls.push({ tool: "camera.mode", args: { mode: "hidden" } });
    skills.push("hidden_cameras");
  }

  const subjects = extractSubjects(lower);
  if (subjects.length) {
    thinking.push(`Resolved ${subjects.length} subject(s): ${subjects.map((s) => s.recipe).join(", ")}.`);
  } else if (
    compose &&
    !mention(lower, ["light", "camera", "turntable", "mood", "first person", "third person"]) &&
    !calls.length
  ) {
    subjects.push({ recipe: "torus", name: "Hero", material: "clay" });
    thinking.push("No noun found — defaulting to a clay torus hero.");
  }

  const wantsGround =
    mention(lower, ["ground", "floor", "studio", "product", "table", "marble", "plinth", "pedestal"]) ||
    (compose && !calls.some((c) => c.tool === "world.build"));
  const hasGroundWord = subjects.some((s) => s.recipe === "plane" || s.recipe === "table" || s.recipe === "room" || s.recipe === "pedestal");

  if (wantsGround && !hasGroundWord && compose && !calls.some((c) => c.tool === "world.build")) {
    if (mention(lower, ["marble", "plinth", "pedestal", "product"])) {
      calls.push(...expandRecipe({ recipe: "pedestal", name: "Plinth", location: [0, 0, 0], material: "marble" }));
      thinking.push("Added a marble plinth for the hero.");
    } else if (!mention(lower, ["room", "city"])) {
      calls.push({
        tool: "object.create",
        args: {
          primitive: "plane",
          name: "Ground",
          location: [0, 0, 0],
          scale: [12, 12, 1],
          material: mention(lower, ["grass"]) ? "foliage" : "matte",
          color: mention(lower, ["grass"]) ? "#3f8f4a" : mention(lower, ["studio", "product"]) ? "#16181f" : "#c8c2b6",
        },
      });
      thinking.push("Added a ground plane so objects read in space.");
    }
  }

  subjects
    .filter((s) => s.recipe !== "plane" || !compose)
    .forEach((subject, index) => {
      const loc = slotForIndex(index, subjects.filter((s) => s.recipe !== "plane").length);
      if (subject.recipe === "plane") return;
      if (subject.recipe === "character") {
        calls.push({
          tool: "character.spawn",
          args: {
            name: subject.name,
            location: loc,
            role: "hero",
            action: mention(lower, ["wave", "揮手"]) ? "wave" : "walk",
            ...(subject.color ? { shirt: subject.color } : {}),
          },
        });
        return;
      }
      const zLift =
        subject.recipe === "torus"
          ? 0.9
          : subject.recipe === "uv_sphere" || subject.recipe === "ico_sphere" || subject.recipe === "cube" || subject.recipe === "monkey"
            ? 0.9
            : 0;
      const location: Vec3 = mention(lower, ["marble", "plinth", "pedestal", "product"])
        ? [loc[0], loc[1], 0.95 + zLift * 0.1]
        : [loc[0], loc[1], loc[2]];
      const recipeCalls: ToolCall[] = isPrimitive(subject.recipe)
        ? [
            {
              tool: "object.create",
              args: {
                primitive: subject.recipe,
                name: subject.name,
                location: [location[0], location[1], location[2] === 0 ? 0.5 : location[2]],
                material: subject.material ?? (mention(lower, ["clay"]) ? "clay" : "plastic"),
                ...(subject.color ? { color: subject.color } : {}),
              },
            },
          ]
        : expandRecipe({
            recipe: subject.recipe,
            name: subject.name,
            location,
            color: subject.color,
            material: subject.material,
          });
      calls.push(...recipeCalls);
    });

  if (mention(lower, ["blue shirt", "紅衫", "外形"]) && subjects.some((s) => s.recipe === "character")) {
    const color = pickColor(lower) ?? "#3b82f6";
    calls.push({ tool: "character.appear", args: { name: "Character", shirt: color } });
  }

  const skipLights = calls.some((c) => c.tool === "world.build") || scene.world.mood === "day";
  const matchedSkills = SKILLS.filter((skill) => {
    if (["truman_world", "town_plaza", "interior_room", "first_person", "third_person", "hidden_cameras", "walk_cycle"].includes(skill.id)) {
      return false;
    }
    return skill.triggers.some((t) => lower.includes(t));
  });
  for (const skill of matchedSkills) {
    skills.push(skill.id);
    calls.push(...skill.expand({}));
    thinking.push(`Matched skill “${skill.name}”.`);
  }

  const hasLightCall = calls.some((c) => c.tool === "light.create");
  const existingLights = scene.objects.some((o) => o.kind === "light") && !calls.some((c) => c.tool === "scene.clear");

  if (!skipLights && !hasLightCall && !existingLights && (compose || subjects.length > 0)) {
    const night = mention(lower, ["night", "neon", "cyber"]);
    const sunset = mention(lower, ["sunset", "golden"]);
    const overcast = mention(lower, ["overcast", "cloudy", "clay"]);
    const skill = SKILLS.find((s) =>
      night ? s.id === "night_neon" : sunset ? s.id === "sunset_rim" : overcast ? s.id === "overcast" : s.id === "studio_soft",
    );
    if (skill) {
      skills.push(skill.id);
      calls.push(...skill.expand({}));
      thinking.push(`No lights specified — applied ${skill.name} so the viewport is readable.`);
    }
  }

  if (mention(lower, ["turntable", "spin", "orbit review"])) {
    if (!skills.includes("turntable")) {
      skills.push("turntable");
      calls.push({ tool: "animation.turntable", args: { mode: "turntable" } });
    }
  }

  if (mention(lower, ["walk", "走路", "wave", "揮手"]) && scene.objects.some((o) => o.bone === "root")) {
    const action = mention(lower, ["wave", "揮手"]) ? "wave" : "walk";
    calls.push({ tool: "character.action", args: { action } });
  }

  const hasCameraMove = calls.some((c) => c.tool === "camera.create" || c.tool === "camera.frame" || c.tool === "camera.mode");
  if (!hasCameraMove && (compose || subjects.length > 0) && !calls.some((c) => c.tool === "world.build")) {
    calls.push({ tool: "camera.frame", args: {} });
    thinking.push("Framed the camera on the new bounding box.");
  }

  if (mention(lower, ["clay"])) {
    const lastMesh = [...subjects].reverse().find((s) => s.recipe !== "plane");
    if (lastMesh) {
      calls.push({
        tool: "object.set_material",
        args: { name: lastMesh.name, material: "clay", color: lastMesh.color ?? "#d5c4ae" },
      });
    }
  }

  if (mention(lower, ["physics", "物理", "碰撞"])) {
    calls.push({ tool: "physics.set", args: { enabled: true } });
  }

  if (!calls.length) {
    thinking.push("Nothing parsed — asking for a more concrete subject.");
    return {
      calls: [],
      skills: [],
      summary: "Ask for a world (楚門的世界), a character, a camera (第一視角 / 第三視覺), or a still-life shot.",
      thinking,
    };
  }

  return { calls, skills, summary: summarize(text, skills, subjects.length), thinking };
}

function pickColor(lower: string) {
  for (const key of Object.keys(COLOR_WORDS).sort((a, b) => b.length - a.length)) {
    if (lower.includes(key)) return COLOR_WORDS[key];
  }
  return undefined;
}

function summarize(text: string, skills: string[], subjectCount: number) {
  const bits = [];
  if (subjectCount) bits.push(`${subjectCount} subject${subjectCount === 1 ? "" : "s"}`);
  if (skills.length) bits.push(`skills ${skills.join(", ")}`);
  return bits.length ? `Compiled “${text}” into ${bits.join(" and ")}.` : `Compiled “${text}”.`;
}

export function describeScene(scene: SceneState) {
  const meshes = scene.objects.filter((o) => o.kind === "mesh");
  const lights = scene.objects.filter((o) => o.kind === "light");
  if (!meshes.length) return "Empty scene. Only a default camera is present.";
  const names = meshes.slice(0, 8).map((m) => `${m.name} (${m.primitive ?? "mesh"}, ${m.material?.preset ?? "default"})`);
  const spatial = scene.followName || scene.cameraMode !== "director" ? ` ${describeSpatial(scene)}` : "";
  return `${meshes.length} mesh${meshes.length === 1 ? "" : "es"}: ${names.join("; ")}. ${lights.length} light${lights.length === 1 ? "" : "s"}. World mood ${scene.world.mood}. BBox ${sceneBBox(scene).size.toFixed(1)}.${spatial}`;
}

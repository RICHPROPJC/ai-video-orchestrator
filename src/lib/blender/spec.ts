import { z } from "zod";
import { getCapabilityCatalog, isWired } from "./capability-catalog";
import { TOOL_CATALOG } from "./catalog";
import playbooks from "./playbooks.json";
import skills from "./skills.json";
import type { ToolName } from "./types";

const name = z.string().min(1).max(160).regex(/^[^\u0000-\u001f]+$/);
const number = z.number().finite();
const vec3 = z.tuple([number, number, number]);
const color = z.string().regex(/^#[a-fA-F0-9]{6}$/);
const material = z.enum([
  "plastic", "matte", "glossy", "rubber", "clay", "metal", "chrome", "gold", "copper", "silver",
  "glass", "toon", "marble", "wood", "emissive", "foliage", "skin", "asphalt", "water", "sky",
]);
const mask = z.enum(["set", "hero", "extras", "door", "ocean", "cams", "sky"]);
const maskId = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6), z.literal(8)]);
const frame = z.number().int().min(-1048574).max(1048574);
const dimensions = { width: z.number().int().min(2).max(8192).optional(), height: z.number().int().min(2).max(8192).optional() };
// Plans name repository-owned shot artifacts; there is no arbitrary filesystem/code field.
const png = z.string().regex(/^shots\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.png$/);
const mp4 = z.string().regex(/^shots\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.mp4$/);
const animation = {
  path: mp4, ...dimensions, frameStart: frame.optional(), frameEnd: frame.optional(),
  fps: z.number().int().min(1).max(240).optional(),
};

export const CharacterActionSchema = z.enum(["idle", "walk", "wave", "sit", "look", "lie", "kneel", "crouch", "lean", "turn_away"]);

function tool<N extends ToolName, A extends z.ZodRawShape>(toolName: N, args: A) {
  return z.strictObject({ tool: z.literal(toolName), args: z.strictObject(args) });
}

export const AuthoringToolCallSchema = z.discriminatedUnion("tool", [
  tool("scene.clear", {}),
  tool("scene.set_world", { color: color.optional(), strength: number.min(0).max(100).optional(), mood: z.enum(["studio", "overcast", "night", "sunset", "neutral", "day"]).optional() }),
  tool("object.create", {
    primitive: z.enum(["cube", "uv_sphere", "ico_sphere", "cylinder", "cone", "torus", "plane", "monkey"]).optional(),
    name: name.optional(), location: vec3.optional(), rotation: vec3.optional(), scale: vec3.optional(),
    material: material.optional(), color: color.optional(),
  }),
  tool("object.transform", { name: name.optional(), id: name.optional(), location: vec3.optional(), rotation: vec3.optional(), scale: vec3.optional() }),
  tool("object.delete", { name: name.optional(), id: name.optional() }),
  tool("object.duplicate", { name: name.optional() }),
  tool("object.rename", { name: name.optional(), id: name.optional(), newName: name }),
  tool("object.set_material", { name: name.optional(), material: material.optional(), color: color.optional() }),
  tool("light.create", {
    name: name.optional(), type: z.enum(["POINT", "SUN", "SPOT", "AREA"]).optional(), location: vec3.optional(),
    energy: number.min(0).max(100000).optional(), color: color.optional(), size: number.positive().optional(),
  }),
  tool("camera.create", { name: name.optional(), location: vec3.optional(), lookAt: vec3.optional(), fov: number.gt(0).lt(180).optional(), force: z.boolean().optional() }),
  tool("camera.frame", { follow: name.optional() }),
  tool("camera.mode", { mode: z.enum(["director", "first_person", "third_person", "hidden"]), follow: name.optional() }),
  tool("animation.turntable", { mode: z.literal("turntable").optional() }),
  tool("world.build", { preset: z.enum(["truman", "plaza", "interior"]) }),
  tool("character.spawn", { name: name.optional(), location: vec3.optional(), role: z.enum(["hero", "extra"]).optional(), shirt: color.optional(), pants: color.optional(), skin: color.optional(), hair: color.optional() }),
  tool("character.appear", { name: name.optional(), shirt: color }),
  tool("character.action", { name: name.optional(), action: CharacterActionSchema }),
  tool("character.move", { name: name.optional(), location: vec3.optional(), yaw: number.optional() }),
  tool("physics.set", { enabled: z.boolean() }),
  tool("mask.set", { name: name.optional(), id: maskId, holdout: z.boolean().optional() }),
  tool("skill.run", { skill: z.enum(Object.keys(skills) as [keyof typeof skills, ...Array<keyof typeof skills>]) }),
  tool("object.place_on", { name, surface: name }),
  tool("object.place_against_wall", { name, wall: name, gap: number.optional() }),
  tool("object.place_beside", { name, reference: name, side: z.enum(["left", "right", "front", "behind"]).optional(), gap: number.optional() }),
  tool("camera.frame_subject", { follow: name.optional(), shot: z.enum(["wide", "medium", "close"]), angle: z.enum(["eye", "high", "low"]).optional() }),
  tool("camera.search", { follow: name.optional(), n: z.literal(4).optional(), shot: z.enum(["wide", "medium", "close"]), angle: z.enum(["eye", "high", "low"]).optional(), proofDir: z.string().regex(/^shots\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/), frameStart: frame.optional(), frameEnd: frame.optional() }),
  tool("render.frame", { path: png, ...dimensions, frame: frame.optional(), mask: mask.optional() }),
  tool("render.animation", animation),
  tool("render.matte", { ...animation, mask }),
]);

const authorOnly = new Set<ToolName>(["object.create", "object.transform", "object.duplicate", "light.create", "camera.create", "animation.turntable", "character.move"]);
const modelOptions = AuthoringToolCallSchema.options.filter((schema) => !authorOnly.has(schema.shape.tool.value) && schema.shape.tool.value !== "character.spawn");
/** Numeric transforms stay inside authored factories; model plans use named relations. */
export const ToolCallSchema = z.discriminatedUnion("tool", [
  tool("character.spawn", { name: name.optional(), role: z.enum(["hero", "extra"]).optional(), shirt: color.optional(), pants: color.optional(), skin: color.optional(), hair: color.optional() }),
  ...modelOptions,
]);
export type ValidatedToolCall = z.infer<typeof AuthoringToolCallSchema>;
export const ToolNameSchema = z.enum(TOOL_CATALOG.map((entry) => entry.name) as [ToolName, ...ToolName[]]);
export const PlanSchema = z.strictObject({
  playbookId: z.enum(playbooks.map((book) => book.id) as [string, ...string[]]),
  calls: z.array(ToolCallSchema).min(1).max(128),
});
export const PlanContextSchema = z.strictObject({
  intent: z.string().min(1).max(256),
  nextAllowed: z.array(ToolNameSchema).max(TOOL_CATALOG.length),
});
export type PlanContext = z.infer<typeof PlanContextSchema>;

/** Exact frozen vocabulary only. Natural-language understanding belongs to the caller's model. */
export function selectPlaybook(intent: string) {
  const normalized = intent.trim().toLowerCase().replace(/\s+/g, " ");
  const book = playbooks.find((entry) => entry.id === normalized || entry.intents.some((alias) => alias.toLowerCase() === normalized));
  if (!book || !isWired(book.id)) return null;
  return structuredClone(book);
}

export function expandedSkill(id: keyof typeof skills): ValidatedToolCall[] {
  return skills[id].map((call) => AuthoringToolCallSchema.parse(call));
}

export function getSpec() {
  return {
    protocol: "astra.protocol.v2", version: "forge.f4.1",
    tools: TOOL_CATALOG.filter((entry) => !authorOnly.has(entry.name)).map((entry) => ({ ...entry })),
    authoringOnly: [...authorOnly],
    playbooks: structuredClone(playbooks), skills: structuredClone(skills),
    capabilities: getCapabilityCatalog(),
    planSchema: z.toJSONSchema(PlanSchema),
    contextSchema: z.toJSONSchema(PlanContextSchema),
    errors: ["plan_invalid", "no_playbook"],
    rules: {
      intent: "Exact authored intent alias or playbook id; no substring fallback or invented vocabulary",
      pick: "Only catalog entries with a receipt; else no_playbook",
      nextAllowed: "Trusted runner context, never model output; applies to every call and expanded skill step",
      preflight: "Validate the complete batch before invoking the executor; obtain new context for each new observation",
      animation: "Even dimensions; inclusive frameEnd >= frameStart; fresh midpoint hero_on_screen gate in Python",
      code: "No raw coordinates, bpy, Python, shell or arbitrary executable text fields; named relational tools only for placement",
    },
  };
}

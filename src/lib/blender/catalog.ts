import type { ToolCall } from "./types";

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
  { name: "camera.frame", summary: "Frame evaluated hero meshes and check camera occlusion", blender: "evaluated mesh bbox + to_track_quat + scene.ray_cast" },
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
  { name: "render.frame", summary: "WORKBENCH FLAT+MATERIAL still PNG; optional mask", blender: "bpy.ops.render.render(write_still=True)" },
  { name: "render.animation", summary: "Blockout MP4 gated by a fresh midpoint hero mask centroid", blender: "evaluated observation + PIL hero_on_screen + PNG sequence + ffmpeg libx264" },
  { name: "render.matte", summary: "Visible pass_index mask MP4; hero=2 extras=3", blender: "pass_index white/black material override + ffmpeg" },
];

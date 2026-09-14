import { SKILLS } from "./skills";
import { sceneBBox } from "./engine";
import type { SceneState, ToolCall, VisionIssue } from "./types";

export function critique(scene: SceneState): VisionIssue[] {
  const issues: VisionIssue[] = [];
  const meshes = scene.objects.filter((o) => o.kind === "mesh");
  const lights = scene.objects.filter((o) => o.kind === "light");
  const cameras = scene.objects.filter((o) => o.kind === "camera");
  const worldLike = scene.world.mood === "day" || scene.objects.some((o) => o.role === "sky" || o.name === "TownGround");
  const ground = meshes.some(
    (m) => m.primitive === "plane" || /ground|floor|plinth|table/i.test(m.name),
  );

  if (!meshes.length) {
    issues.push({
      code: "no_mesh",
      severity: "info",
      message: "還沒有網格。先選一個劇本。",
    });
  }
  if (meshes.length && !lights.length && !worldLike) {
    issues.push({
      code: "no_lights",
      severity: "fix",
      message: "沒有燈光。正在補棚燈。",
    });
  }
  if (!cameras.length) {
    issues.push({
      code: "no_camera",
      severity: "fix",
      message: "場景沒有相機。",
    });
  }
  if (meshes.length && !ground && !worldLike) {
    issues.push({
      code: "no_ground",
      severity: "warn",
      message: "物體懸空，沒有地面。",
    });
  }
  const missingMat = meshes.filter((m) => !m.material);
  if (missingMat.length) {
    issues.push({
      code: "bare_material",
      severity: "warn",
      message: `${missingMat.length} 個網格沒有材質預設。`,
    });
  }
  const box = sceneBBox(scene);
  if (meshes.length && box.size > 40 && !worldLike) {
    issues.push({
      code: "huge_scale",
      severity: "warn",
      message: "場景尺度過大，構圖可能裁切。",
    });
  }
  return issues;
}

export function autoFix(scene: SceneState, issues: VisionIssue[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const issue of issues) {
    if (issue.severity !== "fix") continue;
    if (issue.code === "no_lights") {
      const skill = SKILLS.find((s) => s.id === "studio_soft");
      if (skill) calls.push(...skill.expand({}));
    }
    if (issue.code === "no_camera") {
      calls.push({
        tool: "camera.create",
        args: { location: [7.4, -6.8, 4.8], lookAt: [0, 0, 0.6] },
      });
    }
  }
  if (calls.length) {
    calls.push({ tool: "camera.frame", args: {} });
  }
  return calls;
}

export function visionNotes(scene: SceneState) {
  const issues = critique(scene);
  const meshes = scene.objects.filter((o) => o.kind === "mesh").length;
  const lights = scene.objects.filter((o) => o.kind === "light").length;
  const headline = meshes
    ? `視口：${meshes} 網格，${lights} 燈，${scene.cameraMode === "first_person" ? "第一視角" : scene.cameraMode === "third_person" ? "第三視覺" : scene.cameraMode === "hidden" ? "隱藏鏡頭" : "導演鏡頭"}，${scene.world.mood}。`
    : "視口是空的。";
  return { headline, issues };
}

import { applyCalls } from "./engine";
import { observe, runChecks, type CheckResult, type Observation } from "./observe";
import { pickPlaybook, stepsForPrompt, type Playbook } from "./playbooks";
import { planPrompt } from "./planner";
import type { SceneState, ToolCall, ToolLog } from "./types";

export type RuntimeResult = {
  scene: SceneState;
  logs: ToolLog[];
  playbook: Playbook | null;
  observation: Observation;
  checks: CheckResult[];
  passed: boolean;
  summary: string;
  thinking: string[];
};

export function runLightModel(prompt: string, scene: SceneState): RuntimeResult {
  const thinking: string[] = [];
  const playbook = pickPlaybook(prompt);
  let calls: ToolCall[] = [];
  if (playbook) {
    calls = stepsForPrompt(prompt, playbook);
    thinking.push(`選中劇本 ${playbook.id} ${playbook.version}「${playbook.titleZh}」。`);
    thinking.push(playbook.why);
  } else {
    const plan = planPrompt(prompt, scene);
    calls = plan.calls;
    thinking.push(...plan.thinking);
    thinking.push("沒有命中凍結劇本，退回編譯器。小模型應避免這條路。");
  }

  const applied = applyCalls(scene, calls);
  let next = applied.scene;
  const logs = [...applied.logs];

  const checkIds = playbook?.checks ?? ["has_lights"];
  let checks = runChecks(next, checkIds);

  for (const fail of checks.filter((c) => !c.ok)) {
    const recovery = recover(fail.id);
    if (!recovery.length) continue;
    thinking.push(`驗收失敗 ${fail.id}，重跑修復步驟。`);
    const fixed = applyCalls(next, recovery);
    next = fixed.scene;
    logs.push(...fixed.logs);
  }
  checks = runChecks(next, checkIds);
  const observation = observe(next);
  const passed = checks.every((c) => c.ok);
  const summary = playbook
    ? `${playbook.titleZh} ${playbook.version}：${passed ? "驗收通過" : "仍有失敗項"}。${checks.map((c) => `${c.ok ? "✓" : "✗"}${c.id}`).join(" ")}`
    : `無劇本編譯。${observation.counts.mesh} 個網格。`;

  return { scene: next, logs, playbook, observation, checks, passed, summary, thinking };
}

function recover(checkId: string): ToolCall[] {
  switch (checkId) {
    case "has_hero":
      return [{ tool: "character.spawn", args: { name: "Truman", role: "hero" } }];
    case "has_lights":
      return [{ tool: "skill.run", args: { skill: "studio_soft" } }];
    case "physics_on":
      return [{ tool: "physics.set", args: { enabled: true } }];
    case "camera_embodied":
    case "camera_third":
      return [{ tool: "camera.mode", args: { mode: "third_person" } }];
    case "camera_first":
      return [{ tool: "camera.mode", args: { mode: "first_person" } }];
    case "walking":
      return [{ tool: "character.action", args: { action: "walk" } }];
    default:
      return [];
  }
}

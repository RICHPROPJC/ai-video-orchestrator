export type FloorTab = "canvas" | "board" | "plan" | "block" | "h3" | "qc" | "lock";

export function parseFloorTab(raw?: string): FloorTab {
  if (raw === "canvas" || raw === "plan" || raw === "block" || raw === "h3" || raw === "qc" || raw === "lock") return raw;
  return "board";
}

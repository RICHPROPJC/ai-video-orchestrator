export type FloorTab = "board" | "plan" | "block" | "qc" | "lock";

export function parseFloorTab(raw?: string): FloorTab {
  if (raw === "plan" || raw === "block" || raw === "qc" || raw === "lock") return raw;
  return "board";
}

export type FloorTab = "album" | "canvas" | "board" | "plan" | "block" | "h3" | "qc" | "cut" | "lock";

export function parseFloorTab(raw?: string): FloorTab {
  if (raw === "album" || raw === "canvas" || raw === "plan" || raw === "block" || raw === "h3" || raw === "qc" || raw === "cut" || raw === "lock") return raw;
  return "board";
}

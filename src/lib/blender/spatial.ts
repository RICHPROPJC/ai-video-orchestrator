import { rigRoot } from "./world";
import type { SceneState, Vec3 } from "./types";

function dist(a: Vec3, b: Vec3) {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function describeSpatial(scene: SceneState) {
  const hero = rigRoot(scene, scene.followName ?? "Truman") ?? scene.objects.find((o) => o.role === "hero");
  const origin: Vec3 = hero?.location ?? [0, 0, 0];
  const landmarks = scene.objects.filter(
    (o) =>
      o.kind === "mesh" &&
      (o.role === "set" || o.role === "ocean" || o.role === "sky" || o.role === "hidden_cam") &&
      /Body$|Ocean|Dome$|Plaza|Beach|Door/.test(o.name),
  );
  const near = landmarks
    .map((o) => ({
      name: o.name,
      role: o.role,
      meters: dist(origin, o.location),
      bearing: bearing(origin, o.location),
      depth: o.location[1] - origin[1],
    }))
    .sort((a, b) => a.meters - b.meters)
    .slice(0, 8);

  const cams = scene.objects.filter((o) => o.role === "hidden_cam" && o.kind === "camera");
  const lines = [
    `Camera mode: ${scene.cameraMode}${scene.followName ? ` following ${scene.followName}` : ""}.`,
    `Physics ${scene.physics ? "on" : "off"}, fog ${scene.world.fog.toFixed(3)}, mood ${scene.world.mood}.`,
    hero ? `Hero ${hero.name} at [${hero.location.map((n) => n.toFixed(1)).join(", ")}], action ${hero.action ?? "idle"}.` : "No hero rig.",
    `Depth: +Y is toward the ocean/dome door; −Y is inland. First person sits on the head bone; third person is a 2.4m chase cam.`,
  ];
  if (near.length) {
    lines.push(
      "Spatial: " +
        near.map((n) => `${n.name.replace(/_Body$/, "")} ${n.meters.toFixed(1)}m ${n.bearing}`).join("; ") +
        ".",
    );
  }
  if (cams.length) {
    lines.push(`${cams.length} hidden cameras (Truman-show coverage). Mask IDs: set=1 hero=2 extras=3 door=4 ocean=5 cams=6 sky=8.`);
  }
  return lines.join(" ");
}

function bearing(from: Vec3, to: Vec3) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (Math.abs(dy) > Math.abs(dx) && dy > 0) return "north (ocean)";
  if (Math.abs(dy) > Math.abs(dx) && dy < 0) return "south";
  if (dx > 0) return "east";
  return "west";
}

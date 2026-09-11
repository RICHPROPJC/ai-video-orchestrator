import type { CallSheet, Character, Shot } from "./types";
import { poseCharacter, walkTargets, lerpVec, type LimbPose } from "./ik";

export type SceneSize = { width: number; height: number };

export function sceneSize(aspect: CallSheet["aspect"]): SceneSize {
  if (aspect === "9:16") return { width: 720, height: 1280 };
  if (aspect === "1:1") return { width: 960, height: 960 };
  return { width: 1280, height: 720 };
}

function palettes(sheet: CallSheet) {
  const night = sheet.timeOfDay === "night" || sheet.timeOfDay === "dusk";
  const rain = sheet.weather === "rain" || sheet.weather === "neon";
  if (night && rain) {
    return {
      sky: ["#07080e", "#14182a", "#2a1d28"],
      practical: "#ffb25a",
      neon: "#3ee0c8",
      wet: "#1b2433",
      fog: "rgba(90,110,140,0.18)",
    };
  }
  if (night) {
    return {
      sky: ["#0b1020", "#1a2744", "#3a2a38"],
      practical: "#f0c27a",
      neon: "#7aa2ff",
      wet: "#121826",
      fog: "rgba(40,50,80,0.16)",
    };
  }
  if (sheet.timeOfDay === "dawn") {
    return {
      sky: ["#2a1a28", "#c47a5a", "#f2c9a0"],
      practical: "#ffe0b0",
      neon: "#ffd0a8",
      wet: "#5a4638",
      fog: "rgba(255,210,180,0.16)",
    };
  }
  return {
    sky: ["#87a7c8", "#d7e6f2", "#f7f1e4"],
    practical: "#fff4d2",
    neon: "#8ec5ff",
    wet: "#6b7c6a",
    fog: "rgba(255,255,255,0.12)",
  };
}

function charAt(shot: Shot, character: Character, t: number, size: SceneSize) {
  const mark = shot.marks.find((m) => m.characterId === character.id);
  if (!mark) return null;
  const scale = shot.size === "closeup" ? 2.4 : shot.size === "insert" ? 1.1 : shot.size === "wide" ? 0.72 : 1.15;
  const sx = size.width / 100;
  const sy = size.height / 100;
  const toPx = (p: { x: number; y: number }) => ({ x: p.x * sx, y: p.y * sy });
  if (mark.gait === "walk") {
    const w = walkTargets(toPx(mark.start), toPx(mark.end), t, 18 * scale);
    return poseCharacter({
      hip: w.hip,
      facing: mark.end.x >= mark.start.x ? 1 : -1,
      scale,
      footL: w.footL,
      footR: w.footR,
      handL: w.handL,
      handR: w.handR,
    });
  }
  const hip = lerpVec(toPx(mark.start), toPx(mark.end), t);
  const reach = mark.gait === "reach" ? t : 0.15;
  const handL = toPx(mark.handL);
  const handR = toPx(mark.handR);
  const plantedL = toPx(mark.footL);
  const plantedR = toPx(mark.footR);
  const lift = mark.gait === "turn" ? Math.sin(t * Math.PI) * 8 : 0;
  return poseCharacter({
    hip: { x: hip.x, y: hip.y - lift },
    facing: mark.facing,
    scale,
    footL: plantedL,
    footR: plantedR,
    handL: {
      x: hip.x + (handL.x - hip.x) * (0.35 + reach * 0.7),
      y: hip.y + (handL.y - hip.y) * (0.35 + reach * 0.7),
    },
    handR: {
      x: hip.x + (handR.x - hip.x) * (0.35 + reach * 0.7),
      y: hip.y + (handR.y - hip.y) * (0.35 + reach * 0.7),
    },
  });
}

function limbPath(pose: LimbPose, color: string, accent: string) {
  const line = (a: { x: number; y: number }, b: { x: number; y: number }, w: number, c = color) =>
    `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${c}" stroke-width="${w}" stroke-linecap="round"/>`;
  const dot = (p: { x: number; y: number }, r: number, c: string) =>
    `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${c}"/>`;
  return [
    line(pose.hip, pose.shoulder, 16),
    line(pose.hip, pose.kneeL, 10),
    line(pose.kneeL, pose.footL, 9),
    line(pose.hip, pose.kneeR, 10),
    line(pose.kneeR, pose.footR, 9),
    line(pose.shoulder, pose.elbowL, 8),
    line(pose.elbowL, pose.handL, 7),
    line(pose.shoulder, pose.elbowR, 8),
    line(pose.elbowR, pose.handR, 7),
    `<ellipse cx="${pose.hip.x.toFixed(1)}" cy="${(pose.hip.y - 8).toFixed(1)}" rx="16" ry="22" fill="${color}"/>`,
    `<circle cx="${pose.head.x.toFixed(1)}" cy="${pose.head.y.toFixed(1)}" r="14" fill="${accent}"/>`,
    dot(pose.handL, 5.5, "#f3d2b5"),
    dot(pose.handR, 5.5, "#f3d2b5"),
    `<ellipse cx="${pose.footL.x.toFixed(1)}" cy="${(pose.footL.y + 2).toFixed(1)}" rx="9" ry="4" fill="#1a1210"/>`,
    `<ellipse cx="${pose.footR.x.toFixed(1)}" cy="${(pose.footR.y + 2).toFixed(1)}" rx="9" ry="4" fill="#1a1210"/>`,
  ].join("");
}

function setDress(sheet: CallSheet, shot: Shot, size: SceneSize, pal: ReturnType<typeof palettes>) {
  const w = size.width;
  const h = size.height;
  const loc = `${sheet.location}${shot.location}`.toLowerCase();
  const cafe = /茶餐|cafe|diner|restaurant|舖/.test(loc);
  const street = /街|street|天台|rooftop|lane/.test(loc);
  const bits: string[] = [];
  bits.push(
    `<rect width="${w}" height="${h}" fill="${pal.sky[0]}"/>`,
    `<defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${pal.sky[1]}"/>
        <stop offset="1" stop-color="${pal.sky[0]}"/>
      </linearGradient>
      <radialGradient id="lamp" cx="0.5" cy="0.2" r="0.8">
        <stop offset="0" stop-color="${pal.practical}" stop-opacity="0.55"/>
        <stop offset="1" stop-color="${pal.practical}" stop-opacity="0"/>
      </radialGradient>
    </defs>`,
    `<rect width="${w}" height="${h}" fill="url(#sky)"/>`,
  );
  if (cafe) {
    bits.push(
      `<rect x="0" y="${h * 0.42}" width="${w}" height="${h * 0.58}" fill="#1a120f"/>`,
      `<rect x="${w * 0.08}" y="${h * 0.18}" width="${w * 0.54}" height="${h * 0.36}" fill="#0d1520" stroke="${pal.neon}" stroke-width="3"/>`,
      `<rect x="${w * 0.62}" y="${h * 0.12}" width="${w * 0.28}" height="${h * 0.22}" fill="#2a1a12"/>`,
      `<circle cx="${w * 0.76}" cy="${h * 0.2}" r="${h * 0.08}" fill="url(#lamp)"/>`,
      `<rect x="${w * 0.18}" y="${h * 0.62}" width="${w * 0.28}" height="${h * 0.12}" rx="6" fill="#3a2418"/>`,
      `<rect x="${w * 0.58}" y="${h * 0.58}" width="${w * 0.22}" height="${h * 0.28}" fill="#24160f"/>`,
    );
  } else if (street) {
    bits.push(
      `<polygon points="0,${h * 0.48} ${w},${h * 0.4} ${w},${h} 0,${h}" fill="${pal.wet}"/>`,
      `<rect x="${w * 0.08}" y="${h * 0.08}" width="${w * 0.18}" height="${h * 0.42}" fill="#12151c"/>`,
      `<rect x="${w * 0.72}" y="${h * 0.02}" width="${w * 0.22}" height="${h * 0.5}" fill="#10131a"/>`,
      `<rect x="${w * 0.74}" y="${h * 0.12}" width="${w * 0.16}" height="${h * 0.08}" fill="${pal.neon}" opacity="0.8"/>`,
    );
  } else {
    bits.push(
      `<rect x="0" y="${h * 0.55}" width="${w}" height="${h * 0.45}" fill="${pal.wet}"/>`,
      `<circle cx="${w * 0.78}" cy="${h * 0.22}" r="${h * 0.16}" fill="url(#lamp)"/>`,
    );
  }
  if (sheet.weather === "rain" || sheet.weather === "neon") {
    for (let i = 0; i < 42; i += 1) {
      const x = ((i * 97) % w) + (i % 7) * 3;
      const y = ((i * 53) % h);
      bits.push(
        `<line x1="${x}" y1="${y}" x2="${x + 6}" y2="${y + 28}" stroke="rgba(200,220,255,0.28)" stroke-width="1.4"/>`,
      );
    }
  }
  bits.push(`<rect width="${w}" height="${h}" fill="url(#lamp)"/>`);
  return bits.join("");
}

function letterbox(size: SceneSize) {
  const bar = Math.round(size.height * 0.08);
  return `<rect width="${size.width}" height="${bar}" fill="#050505"/><rect y="${size.height - bar}" width="${size.width}" height="${bar}" fill="#050505"/>`;
}

function lowerThird(shot: Shot, size: SceneSize, frame: number) {
  if (!shot.dialogue) return "";
  const y = size.height - 92;
  return `
    <rect x="48" y="${y}" width="${size.width - 96}" height="52" rx="6" fill="rgba(8,6,4,0.62)"/>
    <text x="64" y="${y + 33}" font-family="WenQuanYi Micro Hei, Droid Sans Fallback, sans-serif" font-size="22" fill="#f4ead8">${escapeXml(shot.dialogue)}</text>
    <text x="${size.width - 64}" y="36" text-anchor="end" font-family="IBM Plex Mono, ui-monospace, monospace" font-size="13" fill="#e2b15c">SC ${shot.id}  F${String(frame).padStart(3, "0")}</text>
  `;
}

function escapeXml(s: string) {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderShotSvg(
  sheet: CallSheet,
  shot: Shot,
  t: number,
  frame: number,
): string {
  const size = sceneSize(sheet.aspect);
  const pal = palettes(sheet);
  const people = sheet.characters
    .map((c) => {
      const pose = charAt(shot, c, t, size);
      if (!pose) return "";
      return limbPath(pose, c.palette[0], c.palette[1]);
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size.width}" height="${size.height}" viewBox="0 0 ${size.width} ${size.height}">
  ${setDress(sheet, shot, size, pal)}
  ${people}
  ${letterbox(size)}
  ${lowerThird(shot, size, frame)}
  <rect width="${size.width}" height="${size.height}" fill="none" stroke="#e2b15c" stroke-opacity="0.18" stroke-width="2"/>
</svg>`;
}

export function renderBlockingSvg(sheet: CallSheet, shot: Shot): string {
  const w = 720;
  const h = 420;
  const marks = shot.marks
    .map((m, i) => {
      const c = sheet.characters.find((ch) => ch.id === m.characterId);
      const color = c?.palette[0] ?? "#e2b15c";
      const x1 = 40 + m.start.x * 6.4;
      const y1 = 40 + m.start.y * 3.4;
      const x2 = 40 + m.end.x * 6.4;
      const y2 = 40 + m.end.y * 3.4;
      const hx = 40 + m.handR.x * 6.4;
      const hy = 40 + m.handR.y * 3.4;
      const fx = 40 + m.footL.x * 6.4;
      const fy = 40 + m.footL.y * 3.4;
      return `
        <circle cx="${x1}" cy="${y1}" r="8" fill="${color}"/>
        <circle cx="${x2}" cy="${y2}" r="8" fill="none" stroke="${color}" stroke-width="2"/>
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-dasharray="4 3"/>
        <circle cx="${hx}" cy="${hy}" r="4" fill="#f3d2b5"><title>hand</title></circle>
        <rect x="${fx - 5}" y="${fy - 3}" width="10" height="6" fill="#1a1210"/>
        <text x="${x1 + 10}" y="${y1 - 10}" font-size="12" font-family="WenQuanYi Micro Hei, sans-serif" fill="#f4ead8">${escapeXml(c?.name ?? m.characterId)} ${m.gait}</text>
        <text x="16" y="${24 + i * 0}" font-size="1" fill="none">${i}</text>
      `;
    })
    .join("");
  const camX = 40 + shot.camera.pos.x * 18;
  const camY = 40 + (10 - shot.camera.pos.y) * 18;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="#12100d"/>
  <rect x="36" y="36" width="648" height="348" fill="#1b1814" stroke="#3a3328"/>
  <polygon points="${camX},${camY} ${camX + 46},${camY - 28} ${camX + 46},${camY + 28}" fill="#e2b15c" opacity="0.85"/>
  <text x="48" y="28" fill="#e2b15c" font-family="IBM Plex Mono, monospace" font-size="12">LAYOUT ${shot.id}  ${shot.size}  ${shot.camera.lensMm}mm</text>
  ${marks}
  <text x="48" y="400" fill="#9a8f7d" font-size="11" font-family="sans-serif">solid = start mark · ring = end mark · beige = hands · black = planted feet</text>
</svg>`;
}

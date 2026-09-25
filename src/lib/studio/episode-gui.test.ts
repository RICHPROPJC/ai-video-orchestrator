import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StoryboardPanel, ShotAudio } from "../../components/episode-media";
import { ShotCanvas } from "../../components/shot-canvas";
import { episodeImageRel, layoutOwnBoards } from "./keyframe-rels";
import type { JobRecord } from "./types";

const job = {
  id: "fixture", outputs: { stills: ["stills/SH01.png"] },
  callSheet: {
    characters: [{ id: "A", name: "阿檸" }], buildings: [],
    shots: [
      { id: "SH01", location: "廚房", marks: [{ characterId: "A" }], props: [{ name: "玻璃樽" }], dialogue: "你飲啦。" },
      { id: "SH02", location: "露台", marks: [{ characterId: "A" }], props: [], dialogue: "" },
    ],
    storyboard: [{ shotId: "SH01", at: "40%", file: "/repo/data/jobs/fixture/boards/cells/SH01.png", board: "/repo/data/jobs/fixture/boards/run/board.png" }],
  },
} as unknown as JobRecord;

test("storyboard tab uses delivered board and cut paths; every thumbnail opens the original", () => {
  const html = renderToStaticMarkup(createElement(StoryboardPanel, { job }));
  assert.match(html, /分鏡板 1/);
  assert.match(html, /分鏡 SH01 40%/);
  assert.match(html, /href="\/api\/media\/fixture\/boards\/run\/board.png"/);
  assert.match(html, /src="\/api\/media\/fixture\/boards\/cells\/SH01.png\?preview=1"/);
  const images = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)];
  assert.equal(images.length, 3, "board, storyboard cut and separate keyframe");
  assert.ok(images.every((m) => m[1]!.endsWith("?preview=1")));
  assert.doesNotMatch(html, /<audio/);
  const draft = renderToStaticMarkup(createElement(StoryboardPanel, { job: { ...job, callSheet: { ...job.callSheet!, storyboard: undefined } } }));
  assert.match(draft, /分鏡未交付/);
});

test("one canvas keeps scene/prop/identity/storyboard nodes; cut and reference edges stay distinct", () => {
  const html = renderToStaticMarkup(createElement(ShotCanvas, { job }));
  assert.match(html, /場景：廚房/);
  assert.match(html, /場景：露台/);
  assert.match(html, /道具：玻璃樽/);
  assert.match(html, /分鏡 SH01 40%/);
  assert.match(html, /portraits\/boards\/A.angles.png\?preview=1/);
  assert.match(html, /未交圖/);
  assert.doesNotMatch(html, /scene-廚房|scene-露台|<audio/);
  assert.equal((html.match(/data-edge="cut"/g) ?? []).length, 1);
  assert.equal((html.match(/data-edge="reference"/g) ?? []).length, 2);
  assert.ok([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].every((m) => m[1]!.endsWith("?preview=1")));
});

test("film audio identifies dialogue and full-shot silence without claiming all takes are AuK", () => {
  const html = renderToStaticMarkup(createElement(ShotAudio, { job }));
  assert.equal((html.match(/<audio/g) ?? []).length, 2);
  assert.match(html, /對白/);
  assert.match(html, /靜音/);
  assert.match(html, /audio\/SH01.wav/);
  assert.match(html, /audio\/SH02.wav/);
  assert.match(html, /preload="none"/);
});

test("only declared buildings get building art; artwork cannot cross episode boundaries", () => {
  const nodes = layoutOwnBoards({ characters: [], locations: ["廚房"], buildings: [{ era: "唐代", types: ["宮殿"] }], props: ["玻璃樽"], right: 0 });
  assert.equal(nodes[0]!.rel, undefined);
  assert.equal(nodes[1]!.rel, "assets/boards/scene-唐代.png");
  assert.equal(nodes[2]!.rel, "assets/01-玻璃樽.png");
  assert.equal(episodeImageRel("/repo/data/jobs/other/boards/cell.png", "fixture"), undefined);
  assert.equal(episodeImageRel("boards/../../private.png", "fixture"), undefined);
  assert.equal(episodeImageRel("/repo/data/jobs/fixture/boards/cell.png", "fixture"), "boards/cell.png");
});

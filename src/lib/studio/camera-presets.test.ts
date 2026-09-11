import test from "node:test";
import assert from "node:assert/strict";
import {
  CAMERA_ANGLES,
  CAMERA_SIDES,
  SHOT_SIZES,
  cameraFor,
  projectToFrame,
  unprojectToPlane,
  viewFrame,
} from "./camera-presets";
import {
  DEPTHS,
  HAND_PLANE_OF_HEIGHT,
  SLOTS,
  STANCES,
  footMid,
  handMid,
  markFor,
  placeHands,
  slotX,
} from "./blocking-grid";
import { BLOCKOUT_HEIGHT, BLOCKOUT_WIDTH } from "./blockout";

const FRAME = { width: BLOCKOUT_WIDTH, height: BLOCKOUT_HEIGHT };
/** The band the writer contract allows for a mannequin (heightM 0.8–1.2). */
const HEIGHTS = [0.8, 0.92, 1, 1.05, 1.2];

test("view_frame keeps Blender's corner order: right-top, right-bottom, left-bottom, left-top", () => {
  const cam = cameraFor("medium", "eye", "frontal");
  const frame = viewFrame(cam, FRAME.width, FRAME.height);
  assert.equal(frame.length, 4);
  const [rt, rb, lb, lt] = frame as NonNullable<typeof frame[number]>[];
  assert.ok(rt!.x > lt!.x, "corner 0 is on the right, corner 3 on the left");
  assert.ok(lb!.x < rb!.x, "corner 2 is on the left, corner 1 on the right");
  assert.ok(rt!.z > rb!.z && lt!.z > lb!.z, "tops sit above bottoms");
});

test("u=0 is frame left and v=0 is frame top (painter's y% down)", () => {
  const cam = cameraFor("wide", "high", "frontal");
  const left = unprojectToPlane(cam, 0.1, 0.8, 0, FRAME).point;
  const right = unprojectToPlane(cam, 0.9, 0.8, 0, FRAME).point;
  assert.ok(left.x < right.x, "u grows to the right");
  const high = unprojectToPlane(cam, 0.5, 0.6, 0, FRAME);
  const low = unprojectToPlane(cam, 0.5, 0.95, 0, FRAME);
  assert.ok(high.point.y > low.point.y, "a smaller v lands further from the lens");
});

test("every preset × slot × depth × stance: the foot ray reaches the floor in front of the lens", () => {
  let checked = 0;
  for (const size of SHOT_SIZES) {
    for (const angle of CAMERA_ANGLES) {
      for (const side of CAMERA_SIDES) {
        const cam = cameraFor(size, angle, side);
        for (const slot of SLOTS) {
          for (const depth of DEPTHS) {
            for (const stance of STANCES) {
              const mark = markFor({ characterId: "A", slot, depth, facing: 1, gait: "plant", stance });
              const { u, v } = footMid(mark);
              const hit = unprojectToPlane(cam, u, v, 0, FRAME);
              assert.ok(hit.t > 0, `${size}/${angle}/${side} ${slot}/${depth} t=${hit.t}`);
              assert.ok(Number.isFinite(hit.point.x) && Number.isFinite(hit.point.y));
              checked += 1;
            }
          }
        }
      }
    }
  }
  assert.equal(checked, 5 * 3 * 3 * 3 * 3 * 3);
});

test("every preset × slot × height: the hand mark unprojects back onto its own figure", () => {
  let worst = 0;
  for (const size of SHOT_SIZES) {
    for (const angle of CAMERA_ANGLES) {
      for (const side of CAMERA_SIDES) {
        const cam = cameraFor(size, angle, side);
        for (const slot of SLOTS) {
          for (const depth of DEPTHS) {
            for (const heightM of HEIGHTS) {
              const grid = markFor({ characterId: "A", slot, depth, facing: 1, gait: "reach", stance: "stand" });
              const feet = footMid(grid);
              const ground = unprojectToPlane(cam, feet.u, feet.v, 0, FRAME).point;
              const mark = placeHands(grid, cam, heightM, FRAME);
              const hand = handMid(mark);
              const hit = unprojectToPlane(cam, hand.u, hand.v, HAND_PLANE_OF_HEIGHT * heightM, FRAME);
              const drift = Math.hypot(hit.point.x - ground.x, hit.point.y - ground.y);
              assert.ok(drift < 0.05, `${size}/${angle}/${side} ${slot}/${depth} h=${heightM} drift=${drift.toFixed(3)}m`);
              worst = Math.max(worst, drift);
            }
          }
        }
      }
    }
  }
  assert.ok(worst > 0, "the round-trip is real arithmetic, not a constant");
});

test("a hand plane above the lens is refused, not silently rendered", () => {
  const cam = cameraFor("wide", "low", "frontal");
  const mark = markFor({ characterId: "A", slot: "C", depth: "far", facing: 1, gait: "plant" });
  const { u, v } = footMid(mark);
  assert.throws(() => unprojectToPlane(cam, u, v, cam.pos.z + 0.5, FRAME), /does not hit the plane|behind the lens/);
});

test("the figure-visibility crop box stays inside the frame for every slot and depth", () => {
  for (const slot of SLOTS) {
    for (const depth of DEPTHS) {
      const mark = markFor({ characterId: "A", slot, depth, facing: 1, gait: "plant" });
      const halfW = 8;
      const halfH = 20;
      assert.ok(mark.start.x - halfW >= 0, `${slot}/${depth} crop runs off the left`);
      assert.ok(mark.start.x + halfW <= 100, `${slot}/${depth} crop runs off the right`);
      assert.ok(mark.start.y - halfH >= 0, `${slot}/${depth} crop runs off the top`);
      assert.ok(mark.start.y + halfH <= 100, `${slot}/${depth} crop runs off the bottom`);
      assert.ok(mark.footL.y < 100 && mark.footR.y < 100, `${slot}/${depth} feet fall out of frame`);
    }
  }
});

test("near spreads the outer slots, far pulls them in, centre never moves", () => {
  assert.ok(slotX("L", "near") < slotX("L", "mid") && slotX("L", "mid") < slotX("L", "far"));
  assert.ok(slotX("R", "near") > slotX("R", "mid") && slotX("R", "mid") > slotX("R", "far"));
  assert.equal(slotX("C", "near"), slotX("C", "far"));
});

test("travelTo moves the end mark, plant leaves it on the start", () => {
  const still = markFor({ characterId: "A", slot: "L", depth: "mid", facing: 1, gait: "plant" });
  assert.deepEqual(still.end, still.start);
  const walk = markFor({ characterId: "A", slot: "L", depth: "mid", facing: -1, gait: "walk", travelTo: "R" });
  assert.equal(walk.end.x, slotX("R", "mid"));
  assert.equal(walk.end.y, walk.start.y);
  assert.equal(walk.facing, -1);
});

test("crouch drops the hands below the body, stand lifts them", () => {
  const stand = markFor({ characterId: "A", slot: "C", depth: "mid", facing: 1, gait: "plant", stance: "stand" });
  const crouch = markFor({ characterId: "A", slot: "C", depth: "mid", facing: 1, gait: "plant", stance: "crouch" });
  assert.ok(stand.handL.y < stand.start.y);
  assert.ok(crouch.handL.y > crouch.start.y);
  assert.equal(crouch.stance, "crouch");
  assert.equal(stand.stanceEnd, undefined);
});

test("projectToFrame is the exact inverse of unprojectToPlane", () => {
  const cam = cameraFor("full", "high", "rightQuarter");
  const world = unprojectToPlane(cam, 0.37, 0.72, 0, FRAME).point;
  const back = projectToFrame(cam, world, FRAME);
  assert.ok(Math.abs(back.u - 0.37) < 1e-9, `u ${back.u}`);
  assert.ok(Math.abs(back.v - 0.72) < 1e-9, `v ${back.v}`);
});

test("every camera keeps a downward tilt, so the upper frame still finds a floor", () => {
  for (const size of SHOT_SIZES) {
    for (const angle of CAMERA_ANGLES) {
      for (const side of CAMERA_SIDES) {
        const cam = cameraFor(size, angle, side);
        assert.ok(cam.lookAt.z < cam.pos.z, `${size}/${angle}/${side} lens is level or tilted up`);
        assert.ok(cam.pos.y <= -2.6 && cam.pos.y >= -9, `${size} dolly ${cam.pos.y} outside the rig`);
      }
    }
  }
});

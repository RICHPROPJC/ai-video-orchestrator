import type { SceneState } from "./types";

export function emptyScene(): SceneState {
  return {
    objects: [
      {
        id: "cam_default",
        name: "Camera",
        kind: "camera",
        location: [7.4, -6.8, 4.8],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        visible: true,
        camera: { fov: 42, lookAt: [0, 0, 0.6] },
      },
    ],
    world: { color: "#0e1016", strength: 0.25, mood: "studio", fog: 0 },
    activeCameraId: "cam_default",
    selectedId: null,
    nextId: 1,
    playback: "idle",
    frame: 1,
    cameraMode: "director",
    followName: null,
    physics: false,
  };
}

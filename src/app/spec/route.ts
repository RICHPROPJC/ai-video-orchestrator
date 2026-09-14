import { getSpec } from "../../lib/blender/spec";

export function GET() {
  return Response.json(getSpec());
}

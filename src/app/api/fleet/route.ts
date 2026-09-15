import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/studio/config";
import { probeFleet } from "@/lib/studio/fleet";

export const runtime = "nodejs";

export async function GET() {
  const fleet = await probeFleet(loadConfig());
  return NextResponse.json(fleet);
}

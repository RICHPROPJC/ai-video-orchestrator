import { NextResponse } from "next/server";
import { clinicH3Plans, formatH3Plan } from "@/lib/studio/h3-slots";

export const dynamic = "force-dynamic";

export function GET() {
  const { hold, hop } = clinicH3Plans();
  return NextResponse.json({
    hold: { plan: hold, lines: formatH3Plan(hold) },
    hop: { plan: hop, lines: formatH3Plan(hop) },
  });
}

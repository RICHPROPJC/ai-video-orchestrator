import { NextResponse } from "next/server";
import { doctor } from "@/lib/studio/doctor";
import { loadConfig, saveConfig, type SlateConfig } from "@/lib/studio/config";

export const runtime = "nodejs";

export async function GET() {
  const report = await doctor();
  return NextResponse.json(report);
}

export async function PUT(req: Request) {
  const body = (await req.json()) as Partial<SlateConfig>;
  const cur = loadConfig();
  const next = {
    ...cur,
    ...body,
    stills: { ...cur.stills, ...body.stills },
    motion: { ...cur.motion, ...body.motion },
    tts: { ...cur.tts, ...body.tts },
    pictureQc: { ...cur.pictureQc, ...body.pictureQc },
    nex: { ...cur.nex, ...body.nex },
    soundQc: { ...cur.soundQc, ...body.soundQc },
    ocr: { ...cur.ocr, ...body.ocr },
    embed: { ...cur.embed, ...body.embed },
    ssh: { ...cur.ssh, ...body.ssh },
  };
  saveConfig(next);
  return NextResponse.json(next);
}

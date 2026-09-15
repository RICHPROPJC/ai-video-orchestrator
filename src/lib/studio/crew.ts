import type { AgentId } from "./types";

export type CrewSeat = {
  name: string;
  job: string;
  en: string;
  thinking: string;
};

/** Named specialists. Producer may dispatch a sealed packet; nobody reads another slate. */
export const FLOOR: AgentId[] = [
  "producer",
  "writer",
  "boards",
  "art",
  "layout",
  "stills",
  "pictureQc",
  "motion",
  "voice",
  "soundQc",
  "editor",
  "delivery",
];

export const CREW: Record<AgentId, CrewSeat> = {
  producer: {
    name: "何晴",
    job: "製片",
    en: "Producer",
    thinking: "可以 dispatch 去專職檯。信封只裝呢份 slate。舊 project vault 當冇見過。",
  },
  writer: {
    name: "阿文",
    job: "編劇",
    en: "Writer",
    thinking: "只寫故事同對白。Shot ID 一出就終身。後面冇權改情節。",
  },
  boards: {
    name: "阿圖",
    job: "分鏡",
    en: "Boards",
    thinking: "分鏡專職。收 packet 寫 narrative plan。SH id 終身。cut = boards。RAG 只問呢份 vault。",
  },
  art: {
    name: "阿釉",
    job: "美術",
    en: "Art",
    thinking: "Grade 同 wardrobe 跟故事，唔另開世界。Prompt 只能描述已有場。",
  },
  layout: {
    name: "阿標",
    job: "走位",
    en: "Layout",
    thinking: "Camera / 手 / 腳 mark 只可以來自分鏡。唔發明第二套走位。",
  },
  stills: {
    name: "阿靜",
    job: "生圖",
    en: "Stills",
    thinking: "一場一 still。Rerank 只可以撈呢份 slate 嘅圖，唔好食隔夜角色。",
  },
  pictureQc: {
    name: "阿察",
    job: "畫檢",
    en: "Picture QC",
    thinking: "Qwen 27B 只問：係咪同一個人、手腳入畫、有冇同 continuity 打架。",
  },
  motion: {
    name: "阿動",
    job: "生片",
    en: "Motion",
    thinking: "H3 first_frame 必須係同一 SH 嘅 still。Vault 跨 job 一律拒。",
  },
  voice: {
    name: "阿聲",
    job: "聲線",
    en: "Voice",
    thinking: "只讀 continuity 對白。Clone 跟角色 pitch，唔加旁白。",
  },
  soundQc: {
    name: "阿耳",
    job: "聲檢",
    en: "Sound QC",
    thinking: "SenseVoice 對稿：WER、情緒、事件。唔過就退回阿聲，唔改劇本。",
  },
  editor: {
    name: "阿剪",
    job: "剪接",
    en: "Editor",
    thinking: "照分鏡 cut[] 接。唔重排、唔加 B-roll。Cut = storyboard。",
  },
  delivery: {
    name: "阿鎖",
    job: "交片",
    en: "Delivery",
    thinking: "三閘全過先 picture lock。交嘅係同一份 continuity 包。",
  },
};

export function seat(id: AgentId) {
  return CREW[id];
}

export function floorLine() {
  return FLOOR.map((id) => {
    const c = CREW[id];
    return { id, ...c };
  });
}

export function whoLine(id: AgentId) {
  const c = CREW[id];
  return `${c.name}／${c.job}`;
}

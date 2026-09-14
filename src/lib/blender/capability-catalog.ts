import playbooks from "./playbooks.json";
import skills from "./skills.json";

export type CapabilityEntry = {
  id: string;
  version: string;
  kind: "skill" | "playbook";
  cast: string[];
  props: string[];
  preconditions: string[];
  doneState: string;
  license: string;
  receipt: string | null;
};

type BookRow = {
  id: string;
  version?: string;
  title?: string;
  intents?: string[];
  cast?: string[];
  props?: string[];
  preconditions?: string[];
  doneState?: string;
  "done-state"?: string;
  license?: string;
  receipt?: string | null;
};

const LICENSE = "repo";
const F4 = "shots/fixtures/f4";
const F2 = "shots/fixtures/f2";
const F1 = "shots/fixtures/f1";

/** Pinned receipts for the F4 snapshot. Kimi JSON fields win when present. */
const PINNED: Record<string, Partial<CapabilityEntry>> = {
  "pb.seahaven.v2": { kind: "playbook", receipt: F4, props: ["dome"], doneState: "truman world built", preconditions: ["empty scene"] },
  "pb.plaza.v2": { kind: "playbook", receipt: F4, props: ["plaza"], doneState: "walkable plaza built", preconditions: ["empty scene"] },
  "pb.interior.v2": { kind: "playbook", receipt: F4, props: ["room"], doneState: "interior built", preconditions: ["empty scene"] },
  "pb.product.v2": { kind: "playbook", receipt: F4, props: ["plinth"], doneState: "studio product set", preconditions: ["empty scene"] },
  "pb.character.v2": { kind: "playbook", receipt: F2, cast: ["hero"], doneState: "hero spawned with action", preconditions: ["world built"] },
  walk_cycle: { kind: "skill", receipt: F2, cast: ["hero"], doneState: "walk keyed", preconditions: ["character spawned"] },
  wave_action: { kind: "skill", receipt: F2, cast: ["hero"], doneState: "wave keyed", preconditions: ["character spawned"] },
  truman_world: { kind: "skill", receipt: F1, props: ["dome"], doneState: "world.build truman", preconditions: ["empty scene"] },
};

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function row(partial: Partial<CapabilityEntry> & { id: string; kind: "skill" | "playbook" }): CapabilityEntry {
  return {
    id: partial.id,
    version: partial.version ?? "forge.f4.1",
    kind: partial.kind,
    cast: partial.cast ?? [],
    props: partial.props ?? [],
    preconditions: partial.preconditions ?? [],
    doneState: partial.doneState ?? "",
    license: partial.license ?? LICENSE,
    receipt: partial.receipt ?? null,
  };
}

/** One queryable list. Model may pick only entries with a receipt. */
export function getCapabilityCatalog(): CapabilityEntry[] {
  const books = (playbooks as BookRow[]).map((book) => {
    const pin = PINNED[book.id] ?? {};
    return row({
      id: book.id,
      kind: "playbook",
      version: book.version ?? pin.version,
      cast: strings(book.cast).length ? strings(book.cast) : pin.cast,
      props: strings(book.props).length ? strings(book.props) : pin.props,
      preconditions: strings(book.preconditions).length ? strings(book.preconditions) : pin.preconditions,
      doneState: book.doneState ?? book["done-state"] ?? pin.doneState,
      license: book.license ?? pin.license,
      receipt: book.receipt === undefined ? pin.receipt ?? null : book.receipt,
    });
  });
  const skillIds = Object.keys(skills) as Array<keyof typeof skills>;
  const skillRows = skillIds.map((id) => {
    const pin = PINNED[id] ?? {};
    return row({
      id,
      kind: "skill",
      version: pin.version,
      cast: pin.cast,
      props: pin.props,
      preconditions: pin.preconditions,
      doneState: pin.doneState,
      license: pin.license,
      receipt: pin.receipt ?? F4,
    });
  });
  return [...books, ...skillRows];
}

export function pickCapability(id: string): CapabilityEntry | null {
  const hit = getCapabilityCatalog().find((entry) => entry.id === id);
  return hit?.receipt ? structuredClone(hit) : null;
}

export function isWired(id: string): boolean {
  return pickCapability(id) !== null;
}

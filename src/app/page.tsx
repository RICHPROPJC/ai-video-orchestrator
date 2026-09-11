import { StudioFloor } from "@/components/studio-floor";
import { listJobs, readEvents, readJob } from "@/lib/studio/store";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ slate?: string }>;
}) {
  const { slate } = await searchParams;
  const job = (slate ? readJob(slate) : listJobs()[0]) ?? null;
  const events = job ? readEvents(job.id) : [];
  const recents = listJobs().slice(0, 6);
  return <StudioFloor initialJob={job} initialEvents={events} recents={recents} />;
}

import type { ReservationRecord } from "../lib/automerge-github.ts";

export function activeSweepReservations(reservations: readonly ReservationRecord[]): ReservationRecord[] {
  const latestByPull = new Map<string, ReservationRecord>();
  for (const record of reservations) {
    if (record.state.kind !== "active") continue;
    const key = `${record.payload.repository_id}#${record.payload.pull_number}`;
    if (!latestByPull.has(key)) latestByPull.set(key, record);
  }
  return [...latestByPull.values()].reverse();
}

export function terminalRepairReservations(reservations: readonly ReservationRecord[], now: Date): ReservationRecord[] {
  const cutoff = now.getTime() - 3 * 24 * 60 * 60_000;
  return reservations.filter((record) => record.state.kind === "terminal" && Date.parse(record.state.at) >= cutoff)
    .sort((a, b) => Date.parse(b.state.kind === "terminal" ? b.state.at : "") - Date.parse(a.state.kind === "terminal" ? a.state.at : "") || b.deploymentId - a.deploymentId).slice(0, 64);
}

export function installedRepositoryId(repositories: readonly { id: number | bigint; full_name: string }[], name: string): number | undefined {
  const id = repositories.find((repository) => repository.full_name.toLowerCase() === name.toLowerCase())?.id;
  return id === undefined ? undefined : Number(id);
}

export function installedRepository(repositories: readonly { id: number | bigint; full_name: string }[], repositoryId: number): string | undefined {
  return repositories.find((repository) => Number(repository.id) === repositoryId)?.full_name;
}

export function resolveRepositoryName(args: { deploymentId: string; repository: string; repositoryId?: number; repositories: readonly { id: number | bigint; full_name: string }[] }): string | undefined {
  if (!args.deploymentId) return args.repository.toLowerCase();
  if (args.repositoryId === undefined) return undefined;
  return installedRepository(args.repositories, args.repositoryId);
}

export function activeReservationForPullByRepositoryId(reservations: readonly ReservationRecord[], repositoryId: number, pullNumber: number): ReservationRecord | undefined {
  return reservations.find((record) => record.payload.repository_id === repositoryId && record.payload.pull_number === pullNumber && record.state.kind === "active");
}

export function evaluationReservation(reservations: readonly ReservationRecord[], deploymentId: string): ReservationRecord | undefined {
  return deploymentId ? reservations.find((record) => String(record.deploymentId) === deploymentId) : reservations[0];
}

export function partitionSweepRepositories(reservations: readonly ReservationRecord[], repositories: ReadonlyMap<number, string>, now: Date): {
  ready: { record: ReservationRecord; repository: string }[];
  expire: ReservationRecord[];
  unavailable: ReservationRecord[];
} {
  const ready: { record: ReservationRecord; repository: string }[] = [];
  const expire: ReservationRecord[] = [];
  const unavailable: ReservationRecord[] = [];
  for (const record of reservations) {
    const repository = repositories.get(record.payload.repository_id);
    if (repository) ready.push({ record, repository });
    else if (Date.parse(record.payload.expires_at) <= now.getTime()) expire.push(record);
    else {
      unavailable.push(record);
      ready.push({ record, repository: record.payload.repository });
    }
  }
  return { ready, expire, unavailable };
}

export function sweepBatch<T>(items: readonly T[], limit = 256): T[] {
  return items.slice(0, limit);
}

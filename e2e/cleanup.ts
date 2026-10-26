export async function withCleanup<T>(run: () => Promise<T>, cleanups: readonly (() => Promise<void>)[]): Promise<T> {
  let primaryFailure: { error: unknown } | undefined;
  try {
    return await run();
  } catch (error) {
    primaryFailure = { error };
    throw error;
  } finally {
    const failures: unknown[] = primaryFailure ? [primaryFailure.error] : [];
    for (const cleanup of cleanups) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1 && !(failures[0] instanceof AggregateError)) throw failures[0];
    if (failures.length > 0) throw new AggregateError(failures, failures.map(failureMessage).join("; "));
  }
}

function failureMessage(error: unknown): string {
  if (error instanceof AggregateError) return `${error.message}: ${error.errors.map(failureMessage).join("; ")}`;
  const message = error instanceof Error ? error.message : String(error);
  const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? ` (HTTP ${error.status})` : "";
  return message + status;
}

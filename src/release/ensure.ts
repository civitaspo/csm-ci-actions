import { Rejection } from "../lib/request.ts";

// Every rejection guard in the release helpers goes through this call so that scripts/mutate-terraform.ts can find it.
export function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Rejection(message);
}

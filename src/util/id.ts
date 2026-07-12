import { randomBase36 } from "./random.ts";

let sequence = 0;

/**
 * A compact, process-unique, time-ordered identifier. Combines a base-36
 * timestamp, a monotonic counter, and a little randomness — enough to label
 * sessions and events without pulling in a UUID dependency.
 */
export function uniqueId(): string {
  return `${Date.now().toString(36)}-${(sequence++).toString(36)}-${randomBase36(6)}`;
}

/** Small, dependency-free randomness helpers shared across the codebase. */

/** A random integer in the half-open range [0, maxExclusive). */
export function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

/** A random lowercase base-36 string of the requested length. */
export function randomBase36(length: number): string {
  let out = "";
  while (out.length < length) out += Math.random().toString(36).slice(2);
  return out.slice(0, length);
}

/** Fisher–Yates shuffle. Mutates and returns the same array. */
export function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/**
 * Returns a full ordering of `items` where each position is drawn without
 * replacement, weighted by `weightOf`. Items with higher weight tend to appear
 * earlier. Non-positive weights are treated as an equal small chance so nothing
 * is ever starved entirely.
 */
export function weightedOrder<T>(items: T[], weightOf: (item: T) => number): T[] {
  const remaining = [...items];
  const ordered: T[] = [];
  while (remaining.length > 0) {
    const weights = remaining.map((item) => Math.max(0, weightOf(item)));
    const total = weights.reduce((sum, w) => sum + w, 0);
    const pickIndex = total > 0 ? weightedPick(weights, total) : randomInt(remaining.length);
    ordered.push(remaining.splice(pickIndex, 1)[0]!);
  }
  return ordered;
}

function weightedPick(weights: number[], total: number): number {
  let target = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    target -= weights[i]!;
    if (target <= 0) return i;
  }
  return weights.length - 1;
}

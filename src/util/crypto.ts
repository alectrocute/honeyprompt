const encoder = new TextEncoder();

/**
 * Constant-time string comparison. Runs in time proportional to the longer
 * input regardless of where the first difference is, so it doesn't leak how
 * much of a secret (e.g. an auth header) a caller guessed correctly.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const length = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

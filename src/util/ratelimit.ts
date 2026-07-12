/**
 * Token-bucket rate limiter. `acquire` resolves as soon as a token is
 * available, refilling continuously at `rps` up to a capacity of `burst`.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly rps: number, private readonly burst: number) {
    this.tokens = burst;
    this.last = performance.now();
  }

  private refill(): void {
    const now = performance.now();
    const elapsedSec = (now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + elapsedSec * this.rps);
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const needed = 1 - this.tokens;
      const waitMs = Math.max(5, (needed / this.rps) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

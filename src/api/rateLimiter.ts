// src/api/rateLimiter.ts — Token Bucket (60 req/min)
import { config } from "../config.js";
import { logger } from "../utils/logger.js";

export class TokenBucket {
  private readonly rate: number;       // tokens/ms
  private readonly burst: number;
  private tokens: number;
  private lastRefill: number;          // Date.now()
  private queue: Array<() => void> = [];
  private processing = false;

  constructor(
    requestsPerMinute = config.rateLimit.requestsPerMinute,
    burst = config.rateLimit.burstSize,
  ) {
    this.rate   = requestsPerMinute / 60_000;  // tokens por ms
    this.burst  = burst;
    this.tokens = burst;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now     = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens   = Math.min(this.burst, this.tokens + elapsed * this.rate);
    this.lastRefill = now;
  }

  /** Retorna uma Promise que resolve quando um token estiver disponível. */
  async acquire(): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      if (!this.processing) this.processQueue();
    });
  }

  private processQueue(): void {
    if (this.queue.length === 0) {
      this.processing = false;
      return;
    }

    this.processing = true;
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      const resolve = this.queue.shift()!;
      resolve();
      setImmediate(() => this.processQueue());
    } else {
      const waitMs = (1 - this.tokens) / this.rate;
      logger.debug(`Rate limit: aguardando ${waitMs.toFixed(0)}ms`);
      setTimeout(() => this.processQueue(), waitMs);
    }
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }
}

// Singleton global
export const rateLimiter = new TokenBucket();
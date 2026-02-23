import { createHash } from 'crypto';

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function jitter(ms: number, factor: number): number {
  const variation = ms * factor;
  return ms + (Math.random() * variation * 2 - variation);
}

export function randomDelay(minMs: number, maxMs: number, jitterFactor: number = 0): number {
  const baseDelay = minMs + Math.random() * (maxMs - minMs);
  if (jitterFactor > 0) {
    return jitter(baseDelay, jitterFactor);
  }
  return baseDelay;
}

export function parseNumeric(value: string): number | null {
  const parsed = parseFloat(value);
  return isNaN(parsed) ? null : parsed;
}

export function parseCard(card: string): string | null {
  const trimmed = card.trim();
  if (!trimmed) return null;
  // Basic validation: should be like "Ah", "Kd", "10s", "Qc", etc.
  if (/^([2-9TJQKA]|10)[hdsc]$/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

export function parseCards(cardsString: string): string[] {
  const cardPattern = /\[([^\]]+)\]/g;
  const cards: string[] = [];
  let match: RegExpExecArray | null;

  while ((match = cardPattern.exec(cardsString)) !== null) {
    const card = parseCard(match[1]);
    if (card) {
      cards.push(card);
    }
  }

  return cards;
}

export function microsToDate(micros: string): Date {
  const timestamp = BigInt(micros);
  const milliseconds = Number(timestamp / 1000n);
  return new Date(milliseconds);
}

export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function deriveHandId(gameId: string, handNumber: number, firstCreatedAt: string): string {
  return sha256(`${gameId}:${handNumber}:${firstCreatedAt}`);
}

export function extractGameId(roomUrl: string): string | null {
  const match = roomUrl.match(/\/games\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

export class ExponentialBackoff {
  private attempt = 0;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitterFactor: number;

  constructor(initialDelayMs = 300, maxDelayMs = 5000, jitterFactor = 0.2) {
    this.initialDelayMs = initialDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.jitterFactor = jitterFactor;
  }

  async wait(): Promise<void> {
    const delay = Math.min(
      this.initialDelayMs * Math.pow(2, this.attempt),
      this.maxDelayMs
    );
    const delayWithJitter = jitter(delay, this.jitterFactor);
    await sleep(delayWithJitter);
    this.attempt++;
  }

  reset(): void {
    this.attempt = 0;
  }

  getAttempt(): number {
    return this.attempt;
  }
}

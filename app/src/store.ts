import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DomainEvent } from './model.ts';

export interface EventStore {
  load(): DomainEvent[];
  append(e: DomainEvent): void;
  logRaw(name: string, delivery: string, payload: unknown): void;
  seenDelivery(delivery: string): boolean;
}

// Append-only JSON Lines files: raw webhooks (for replay and audit) and domain events (the source of state).
// Kept deliberately simple for the demo; the platform plan swaps this for a Postgres event table.
export class FileStore implements EventStore {
  private events: string;
  private raw: string;
  private deliveries = new Set<string>();

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.events = join(dir, 'events.jsonl');
    this.raw = join(dir, 'webhooks.jsonl');
    for (const line of readLines(this.raw)) {
      try { this.deliveries.add(JSON.parse(line).delivery); } catch { /* skip a torn line */ }
    }
  }

  load(): DomainEvent[] {
    return readLines(this.events).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  }

  append(e: DomainEvent) { appendFileSync(this.events, JSON.stringify(e) + '\n'); }

  logRaw(name: string, delivery: string, payload: unknown) {
    this.deliveries.add(delivery);
    appendFileSync(this.raw, JSON.stringify({ at: new Date().toISOString(), name, delivery, payload }) + '\n');
  }

  seenDelivery(delivery: string) { return this.deliveries.has(delivery); }
}

export class MemoryStore implements EventStore {
  events: DomainEvent[] = [];
  private deliveries = new Set<string>();
  load() { return [...this.events]; }
  append(e: DomainEvent) { this.events.push(e); }
  logRaw(_n: string, delivery: string) { this.deliveries.add(delivery); }
  seenDelivery(delivery: string) { return this.deliveries.has(delivery); }
}

function readLines(path: string): string[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean);
}

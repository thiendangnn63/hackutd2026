import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyAction, createSeed } from './domain.js';

export class Store {
  #sessionId = randomUUID();
  #revision = 0;
  #listeners = new Set();
  #notifications = [];
  #notifying = false;

  constructor(path = null) {
    this.path = path;
    this.state = createSeed();
    if (path) {
      try { this.state = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read demo data. Back it up before resetting; it was not overwritten.', { cause: error }); }
    }
  }
  read() { return structuredClone(this.state); }
  get version() { return { sessionId: this.#sessionId, revision: this.#revision }; }
  readVersioned() { return { ...this.version, state: this.read() }; }
  onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('A state observer must be a function.');
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #notify() {
    if (!this.#listeners.size) return;
    this.#notifications.push(this.readVersioned());
    if (this.#notifying) return;
    this.#notifying = true;
    try {
      while (this.#notifications.length) {
        const snapshot = this.#notifications.shift();
        for (const listener of [...this.#listeners]) {
          if (!this.#listeners.has(listener)) continue;
          try {
            // A subscriber cannot mutate another subscriber's snapshot or turn
            // a committed action into a failed HTTP response.
            const pending = listener(structuredClone(snapshot));
            if (pending && typeof pending.catch === 'function') pending.catch(() => {});
          } catch { /* Observers are isolated from committed persistence. */ }
        }
      }
    } finally { this.#notifying = false; }
  }
  save(next) {
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    }
    this.state = next;
    this.#revision++;
    this.#notify();
  }
  act(action, ...args) {
    const { state, result } = applyAction(this.state, action, ...args);
    this.save(state);
    return { ...this.read(), ...result };
  }
  reset() { this.save(createSeed()); return this.read(); }
}

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { applyAction, createSeed } from './domain.js';

export class Store {
  constructor(path = null) {
    this.path = path;
    this.state = createSeed();
    if (path) {
      try { this.state = JSON.parse(readFileSync(path, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read demo data. Back it up before resetting; it was not overwritten.', { cause: error }); }
    }
  }
  read() { return structuredClone(this.state); }
  save(next) {
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, this.path);
    }
    this.state = next;
  }
  act(action, ...args) {
    const { state, result } = applyAction(this.state, action, ...args);
    this.save(state);
    return { ...this.read(), ...result };
  }
  reset() { this.save(createSeed()); return this.read(); }
}

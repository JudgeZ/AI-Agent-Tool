import { vi } from 'vitest';

export class FitAddon {
  static instances: FitAddon[] = [];
  fit = vi.fn();
  dispose = vi.fn();

  constructor() {
    FitAddon.instances.push(this);
  }
}

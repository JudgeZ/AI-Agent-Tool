import { vi } from 'vitest';

export class Terminal {
  static instances: Terminal[] = [];

  cols = 80;
  rows = 24;
  loadAddon = vi.fn();
  open = vi.fn();
  focus = vi.fn();
  dispose = vi.fn();
  write = vi.fn();
  dataHandler: ((input: string) => void) | null = null;
  onData = vi.fn((handler: (input: string) => void) => {
    this.dataHandler = handler;
    return {
      dispose: vi.fn(() => {
        if (this.dataHandler === handler) {
          this.dataHandler = null;
        }
      }),
    };
  });

  constructor() {
    Terminal.instances.push(this);
  }
}

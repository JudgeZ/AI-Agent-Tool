import { vi } from 'vitest';

export class MockTerminal {
  static instances: MockTerminal[] = [];
  cols = 80;
  rows = 24;
  dataHandler: ((input: string) => void) | null = null;
  write = vi.fn();
  dispose = vi.fn();
  loadAddon = vi.fn();
  open = vi.fn();
  focus = vi.fn();
  constructor() {
    MockTerminal.instances.push(this);
  }
  onData(handler: (input: string) => void) {
    this.dataHandler = handler;
    return { dispose: () => { this.dataHandler = null; } };
  }
}

export class MockFitAddon {
  static instances: MockFitAddon[] = [];
  dispose = vi.fn();
  fit = vi.fn();
  constructor() {
    MockFitAddon.instances.push(this);
  }
}

export function resetTerminalMocks() {
  MockTerminal.instances.length = 0;
  MockFitAddon.instances.length = 0;
}

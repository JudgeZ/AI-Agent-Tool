export class MockEventSource {
  static instances: MockEventSource[] = [];

  static reset() {
    for (const instance of MockEventSource.instances) {
      instance.listeners.clear();
      instance.closed = true;
      instance.onopen = null;
      instance.onerror = null;
      instance.onmessage = null;
    }
    MockEventSource.instances = [];
  }

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  public onopen: ((this: EventSource, ev: Event) => unknown) | null = null;
  public onerror: ((this: EventSource, ev: Event) => unknown) | null = null;
  public onmessage: ((this: EventSource, ev: MessageEvent) => unknown) | null = null;
  public readyState = this.CONNECTING;
  public closed = false;
  private readonly listeners: Map<string, Set<(event: MessageEvent<string>) => void>> = new Map();

  constructor(public readonly url: string, public readonly eventSourceInitDict?: EventSourceInit) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: MessageEvent<string>) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(_event: Event): boolean {
    return true;
  }

  close() {
    this.closed = true;
    this.readyState = this.CLOSED;
  }

  emit(type: string, data: unknown) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    const event = new MessageEvent(type, { data: payload });
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }

  triggerOpen() {
    this.readyState = this.OPEN;
    this.onopen?.call(this as unknown as EventSource, new Event('open'));
  }

  triggerError(data?: unknown) {
    let errorEvent: Event;
    if (data instanceof Event) {
      errorEvent = data;
    } else if (typeof data === 'string') {
      errorEvent = new MessageEvent('error', { data });
    } else if (data) {
      errorEvent = new MessageEvent('error', { data: JSON.stringify(data) });
    } else {
      errorEvent = new Event('error');
    }
    this.onerror?.call(this as unknown as EventSource, errorEvent);
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

export type SseQuotaIdentity = {
  ip?: string;
  subjectId?: string;
};

export type SseQuotaLimits = {
  perIp: number;
  perSubject: number;
};

export class SseQuotaManager {
  private readonly perIpLimit: number;
  private readonly perSubjectLimit: number;
  private readonly ipCounts = new Map<string, number>();
  private readonly subjectCounts = new Map<string, number>();

  constructor(limits: SseQuotaLimits) {
    this.perIpLimit = Math.max(0, Math.floor(limits.perIp));
    this.perSubjectLimit = Math.max(0, Math.floor(limits.perSubject));
  }

  acquire(identity: SseQuotaIdentity): (() => void) | null {
    const ipKey = normalizeKey(identity.ip);
    const subjectKey = normalizeKey(identity.subjectId);

    if (this.perSubjectLimit > 0 && subjectKey) {
      const current = this.subjectCounts.get(subjectKey) ?? 0;
      if (current >= this.perSubjectLimit) {
        return null;
      }
    }

    if (this.perIpLimit > 0 && ipKey) {
      const current = this.ipCounts.get(ipKey) ?? 0;
      if (current >= this.perIpLimit) {
        return null;
      }
    }

    if (this.perSubjectLimit > 0 && subjectKey) {
      this.subjectCounts.set(subjectKey, (this.subjectCounts.get(subjectKey) ?? 0) + 1);
    }

    if (this.perIpLimit > 0 && ipKey) {
      this.ipCounts.set(ipKey, (this.ipCounts.get(ipKey) ?? 0) + 1);
    }

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.perSubjectLimit > 0 && subjectKey) {
        decrementCounter(this.subjectCounts, subjectKey);
      }
      if (this.perIpLimit > 0 && ipKey) {
        decrementCounter(this.ipCounts, ipKey);
      }
    };
  }
}

function normalizeKey(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function decrementCounter(map: Map<string, number>, key: string): void {
  const current = map.get(key);
  if (current === undefined) {
    return;
  }
  if (current <= 1) {
    map.delete(key);
    return;
  }
  map.set(key, current - 1);
}


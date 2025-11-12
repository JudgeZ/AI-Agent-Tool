function coercePart(part: unknown): string {
  if (part === undefined || part === null) {
    return "";
  }
  if (typeof part === "string") {
    return part;
  }
  if (typeof part === "number" || typeof part === "boolean" || typeof part === "bigint") {
    return String(part);
  }
  if (part instanceof Error) {
    return part.message;
  }
  if (typeof part === "object") {
    try {
      return JSON.stringify(part);
    } catch {
      return String(part);
    }
  }
  return String(part);
}

function formatLine(parts: unknown[]): string {
  const formatted = parts
    .map(coercePart)
    .filter(segment => segment.length > 0);
  return formatted.join(" ");
}

export function printLine(...parts: unknown[]): void {
  const line = formatLine(parts);
  process.stdout.write(line.length > 0 ? `${line}\n` : "\n");
}

export function printErrorLine(...parts: unknown[]): void {
  const line = formatLine(parts);
  process.stderr.write(line.length > 0 ? `${line}\n` : "\n");
}

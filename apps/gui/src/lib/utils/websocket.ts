export function toWebsocketBase(httpUrl: string): string {
  const parsed = new URL(httpUrl);

  if (parsed.protocol === 'https:') {
    parsed.protocol = 'wss:';
  } else if (parsed.protocol === 'http:') {
    parsed.protocol = 'ws:';
  } else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Unsupported websocket base protocol: ${parsed.protocol}`);
  }

  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

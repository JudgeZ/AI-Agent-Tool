export function toWebsocketBase(httpUrl: string): string {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const parsed = new URL(httpUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

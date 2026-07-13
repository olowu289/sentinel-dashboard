/** Browser fetch wrapper for Platform API calls (bound + ngrok free-tier bypass). */
export function createPlatformFetch(baseUrl: string): typeof fetch {
  const skipNgrokWarning = baseUrl.includes('ngrok');
  return (input, init) => {
    const headers = new Headers(init?.headers);
    if (skipNgrokWarning) headers.set('ngrok-skip-browser-warning', '1');
    return globalThis.fetch(input, { ...init, headers });
  };
}

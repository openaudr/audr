import { beforeEach, vi } from 'vitest';

/** What the global `fetch` rejects with in tests: no test may reach a real network. */
export class LiveNetworkBlocked extends Error {
  override readonly name = 'LiveNetworkBlocked';
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new LiveNetworkBlocked('unexpected real HTTP request'))),
  );
  // A developer's own Lago credentials must not leak into, or change, any test.
  for (const name of ['LAGO_API_KEY', 'LAGO_API_URL']) {
    vi.stubEnv(name, undefined);
  }
});

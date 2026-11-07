import { vi } from "vitest";

type Handler = (req: Request) => Response | Promise<Response>;

/**
 * Mock fetch theo "METHOD origin+path" (bỏ query). Request không có trong bảng thì ném lỗi,
 * để test không bao giờ gọi thật Facebook/Pinterest.
 */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: Request[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    calls.push(req.clone());
    const url = new URL(req.url);
    const handler = routes[`${req.method} ${url.origin}${url.pathname}`];
    if (!handler) throw new Error(`unmocked fetch: ${req.method} ${url.origin}${url.pathname}`);
    return handler(req);
  });
  return calls;
}

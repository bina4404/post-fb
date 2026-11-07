export type TargetStatus = "draft" | "scheduled" | "publishing" | "published" | "failed";
export type Target = {
  id: number;
  platform: "facebook" | "pinterest";
  accountId: number;
  boardId: number | null;
  status: TargetStatus;
  externalPostId: string | null;
  lastError: string | null;
  needsAttention: boolean;
};
export type Post = {
  id: number;
  caption: string;
  link: string | null;
  imageKey: string | null;
  imageUrl: string | null;
  scheduledAt: number | null;
  createdAt: number;
  targets: Target[];
};
export type Account = { id: number; platform: "facebook" | "pinterest"; name: string; enabled: boolean; status: string };
export type Board = { id: number; accountId: number; name: string; enabled: boolean };
export type Destinations = { accounts: Account[]; boards: Board[] };
export type Slot = { id: number; weekday: number; minuteOfDay: number };

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { error?: string; errors?: { line: number; message: string }[] },
  ) {
    super(body.error ?? `HTTP ${status}`);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    ...rest,
    headers: json !== undefined ? { "content-type": "application/json" } : rest.headers,
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export type TargetRow = {
  id: number;
  postId: number;
  platform: "facebook" | "pinterest";
  status: TargetStatus;
  attempts: number;
  externalPostId: string | null;
  lastError: string | null;
  needsAttention: boolean;
  scheduledAt: number | null;
  caption: string;
  destination: string;
  boardName: string | null;
  accountStatus: string;
};

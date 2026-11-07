import { log } from "../lib/log";

/** transient: thử lại được. auth: token hỏng, cần kết nối lại. permanent: sửa dữ liệu/quyền mới hết. */
export type ErrorKind = "transient" | "permanent" | "auth";
export type PlatformName = "facebook" | "pinterest";

/** Lỗi khi đăng bài mà publisher biết cách xử lý (retry hoặc dừng). */
export class PublishFailure extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export class PlatformError extends PublishFailure {
  constructor(
    readonly platform: PlatformName,
    readonly op: string,
    kind: ErrorKind,
    readonly status: number,
    readonly code: string | number | null,
    message: string,
  ) {
    super(kind, message);
  }
}

/** Tạo lỗi và ghi log có cấu trúc. Chỉ log mã lỗi và message của nền tảng, không bao giờ log URL/token. */
export function platformError(
  platform: PlatformName,
  op: string,
  kind: ErrorKind,
  status: number,
  code: string | number | null,
  message: string,
): PlatformError {
  log("warn", "platform_error", { platform, op, kind, status, code, message });
  return new PlatformError(platform, op, kind, status, code, message);
}

export const TIMEOUT_MS = 30_000;

/** fetch có timeout. Lỗi mạng hoặc timeout luôn là lỗi tạm thời. */
export async function fetchWithTimeout(platform: PlatformName, op: string, url: string, init: RequestInit = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw platformError(platform, op, "transient", 0, null, (err as Error).name);
  }
}

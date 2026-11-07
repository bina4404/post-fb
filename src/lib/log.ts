type Fields = Record<string, string | number | boolean | null | undefined>;

/** Log có cấu trúc. Không bao giờ truyền token, header hay URL chứa token vào đây. */
export function log(level: "info" | "warn" | "error", event: string, fields: Fields = {}) {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

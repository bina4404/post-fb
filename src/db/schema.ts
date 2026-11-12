import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// Mọi thời gian là epoch milliseconds UTC.
const platform = () => text("platform", { enum: ["facebook"] }).notNull();
// Tài khoản/OAuth còn có Google Drive (nơi lưu ảnh). Enum chỉ ở TypeScript, SQLite không có CHECK nên không cần migration.
const accountPlatform = () => text("platform", { enum: ["facebook", "google"] }).notNull();

// Không bao giờ xoá dòng: post_targets trỏ tới đây. Ngắt kết nối = xoá token + enabled=false.
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: accountPlatform(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    accessExpiresAt: integer("access_expires_at"),
    refreshExpiresAt: integer("refresh_expires_at"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    // Đăng tự động từ kho ảnh cho Page này (giờ đăng ở bảng page_times).
    autoEnabled: integer("auto_enabled", { mode: "boolean" }).notNull().default(false),
    // paused: Facebook chặn Page vì nghi lạm dụng (mã 368); kết nối lại Facebook để chạy tiếp. Enum chỉ ở TypeScript.
    status: text("status", { enum: ["ok", "needs_reauth", "paused"] }).notNull().default("ok"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [unique().on(t.platform, t.externalId)],
);

// Không còn dùng (đã bỏ Pinterest). Giữ bảng và cột board_id để khỏi phải migration xoá dữ liệu.
export const boards = sqliteTable(
  "boards",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [unique().on(t.accountId, t.externalId)],
);

export const posts = sqliteTable("posts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  caption: text("caption").notNull(),
  link: text("link"),
  imageKey: text("image_key"),
  imageUrl: text("image_url"),
  scheduledAt: integer("scheduled_at"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (t) => [
  // Bộ lập lịch tự động tra "ảnh này đã/sẽ đăng lúc nào" theo image_key và thời gian.
  index("posts_image_idx").on(t.imageKey, t.scheduledAt),
  index("posts_scheduled_idx").on(t.scheduledAt),
]);

export const targetStatuses = ["draft", "scheduled", "publishing", "published", "failed"] as const;

export const postTargets = sqliteTable(
  "post_targets",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    postId: integer("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    platform: platform(),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id),
    boardId: integer("board_id").references(() => boards.id),
    status: text("status", { enum: targetStatuses }).notNull().default("draft"),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    lockedAt: integer("locked_at"),
    externalPostId: text("external_post_id"),
    lastError: text("last_error"),
    needsAttention: integer("needs_attention", { mode: "boolean" }).notNull().default(false),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("post_targets_due_idx").on(t.status, t.nextAttemptAt),
    // Thư viện lọc/đếm theo bài, giãn cách đọc theo Page: tránh quét cả bảng khi có hàng nghìn target.
    index("post_targets_post_idx").on(t.postId, t.status),
    index("post_targets_account_idx").on(t.accountId, t.status, t.updatedAt),
  ],
);

// Khung giờ lặp lại theo giờ Asia/Bangkok.
export const scheduleSlots = sqliteTable(
  "schedule_slots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    weekday: integer("weekday").notNull(),
    minuteOfDay: integer("minute_of_day").notNull(),
  },
  (t) => [unique().on(t.weekday, t.minuteOfDay)],
);

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  platform: accountPlatform(),
  createdAt: integer("created_at").notNull(),
});

// Cài đặt chung cho cả app, đúng một dòng (id = 1). Múi giờ lưu ở đây để mọi phiên đăng nhập dùng chung.
export const appSettings = sqliteTable("app_settings", {
  id: integer("id").primaryKey(),
  timeZone: text("time_zone").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Kho ảnh cho đăng tự động: ảnh trong thư mục post-fb trên Drive, kèm tối đa 10 caption (JSON array). */
export const images = sqliteTable("images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  driveFileId: text("drive_file_id").notNull().unique(),
  name: text("name").notNull(),
  captions: text("captions", { mode: "json" }).$type<string[]>().notNull().default([]),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Giờ đăng tự động của từng Page, áp dụng mọi ngày, theo múi giờ của app (phút trong ngày 0–1439). */
export const pageTimes = sqliteTable(
  "page_times",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    accountId: integer("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    minuteOfDay: integer("minute_of_day").notNull(),
  },
  (t) => [unique().on(t.accountId, t.minuteOfDay)],
);

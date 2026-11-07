import { index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

// Mọi thời gian là epoch milliseconds UTC.
const platform = () => text("platform", { enum: ["facebook", "pinterest"] }).notNull();

// Không bao giờ xoá dòng: post_targets trỏ tới đây. Ngắt kết nối = xoá token + enabled=false.
export const accounts = sqliteTable(
  "accounts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    platform: platform(),
    externalId: text("external_id").notNull(),
    name: text("name").notNull(),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    accessExpiresAt: integer("access_expires_at"),
    refreshExpiresAt: integer("refresh_expires_at"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    status: text("status", { enum: ["ok", "needs_reauth"] }).notNull().default("ok"),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [unique().on(t.platform, t.externalId)],
);

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
});

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
  (t) => [index("post_targets_due_idx").on(t.status, t.nextAttemptAt)],
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
  platform: platform(),
  createdAt: integer("created_at").notNull(),
});

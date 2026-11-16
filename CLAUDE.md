# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Scheduled posting to Facebook Pages (photos and Reels), served at `https://tools.new2h.com`. One Cloudflare Worker hosts both the Hono API (`/api/*`) and the React SPA (Static Assets from `dist/`), backed by D1, a cron trigger, a Queue, Cloudflare Access for login, and Google Drive for media storage. UI text, comments, docs and log messages are in Vietnamese; keep it that way.

- `README.md`: local setup. `PLAN.md`: the design doc, with a dated changelog at the top (read that first, since later sections still describe the dropped Pinterest integration). `DEPLOY.md`: production checklist.

## Commands

Node 24+. Local setup: `cp .dev.vars.example .dev.vars` (set `DEV_AUTH_BYPASS=1`), then `npm run db:migrate:local`, `npm run build`, `npm run dev` (Worker + SPA at :8787). Run `npm run dev:web` as well for Vite hot reload at :5173, which proxies `/api` to :8787.

| Command | What it does |
|---|---|
| `npm run typecheck` | `wrangler types` (generates `worker-configuration.d.ts`, git-ignored), then `tsc` for the Worker and again for `web/` (`tsconfig.web.json`) |
| `npm run lint` | ESLint |
| `npm test` | Vitest inside the Workers runtime (`@cloudflare/vitest-plugin`) against a real local D1 with all migrations applied |
| `npx vitest run test/publish.test.ts` / `-t "<name>"` | one test file / one test |
| `npm run db:generate` | after editing `src/db/schema.ts`, generates a new SQL migration in `migrations/` |

CI (`.github/workflows/ci.yml`) runs typecheck → lint → build → test. **Tests need `dist/` to exist** (`wrangler.jsonc` points assets at it), so run `npm run build` once before `npm test` on a fresh checkout.

Anything with `--remote`, `wrangler deploy` or `wrangler secret` hits production: leave it for the user. Pushing `main` deploys automatically via Workers Builds (migrations are applied remotely first).

## Architecture

Entry `src/index.ts` exports three handlers:
- `fetch` → `src/app.ts`: Hono app under `/api`. Every route goes through `sameOriginWrites` and `requireAccess` (checks the Cloudflare Access JWT; `DEV_AUTH_BYPASS` only works when the hostname is `localhost`). Routes live in `src/routes/`, with bodies validated by Zod.
- `scheduled` (every minute) → `src/jobs/cron.ts`: fails targets stuck in `publishing`, then enqueues due targets. On minute 0 it also syncs Drive images and Reel videos (`jobs/drive-sync.ts`), collects Facebook insights for posts published 7+ days ago (`jobs/insights.ts`), runs the auto-post planner (`jobs/planner.ts` + `lib/autoplan.ts`, which fills 7 days ahead), then asks Claude for caption suggestions (`jobs/ai-content.ts`; skipped when `ANTHROPIC_API_KEY` is unset).
- `queue` → `src/jobs/publish.ts`: claims a target atomically and publishes it via `src/platforms/facebook.ts`.

Invariants that span several files (see PLAN.md §5):
- **State lives on `post_targets`** (one post × one Page), not on `posts`. One post can go to several Pages, each with its own status.
- **Retries live in the DB** (`next_attempt_at`), not in Queue retries. Cron is the only thing that enqueues, and consumers always ack. A duplicate message is harmless because publishing first wins an atomic `UPDATE … WHERE status='scheduled' … RETURNING`.
- **A target stuck in `publishing` is never auto-retried.** It goes to `failed` + `needs_attention`, because Facebook may already have the post. Only the user's "Đăng lại" (repost) action re-queues it, and it is blocked once `external_post_id` exists.
- Errors are classified in `src/platforms/errors.ts` as transient, permanent or auth. Auth errors mark the account `needs_reauth`, and that account's targets wait in `scheduled` instead of failing. FB code 368 pauses the Page (`accounts.status='paused'`; that enum exists only in TypeScript, not in SQL).
- Pacing (`src/lib/pacing.ts`): at least 10 min between posts on a Page, at most 25 posts per Page per 24 h, the same content staggered across Pages, and one post per Page per cron tick.
- Auto-posts are ordinary posts with idempotency key `auto:<page>:<time>`, so pacing, retry and repost all apply to them.
- Content strategy (driven by a page-analysis report, see PLAN.md 16/11/2026): the `images` table is the whole content library — `kind` image/reel/text (text items have a synthetic `drive_file_id` `text-<uuid>` and are never downloaded; `publish.ts` skips the image for `kind = 'text'`). `page_times` rows carry a weekday bitmask (`days`, bit 0 = Sunday) and an optional fixed `topic_id`; a null topic means the planner picks one weighted by measured views (`topicWeights`). `posts.topic_id` is stamped at planning time so stats survive re-tagging.
- AI output never goes straight to the schedule: Claude writes into `images.suggestions`; only `images.captions` (user-approved) are planned. The planner also never reuses a (media, Page, caption) triple, across all history.
- Writing insight stats must not touch `post_targets.updated_at` (pacing reads it as the publish time).
- Facebook and Google tokens are stored encrypted (`lib/crypto.ts`, `TOKEN_ENC_KEY`). Never log tokens, URLs with `access_token`, or request bodies. Use `log(level, event, fields)` from `lib/log.ts`.
- The time zone is app-wide (`app_settings`). Times are stored as epoch ms UTC. `src/lib/time.ts` is the only file shared by the Worker and `web/`.
- D1 limits: 100 bound parameters per statement, plus a per-request statement cap. Batch and chunk writes accordingly (see `jobs/drive-sync.ts`).
- The `boards` table and `post_targets.board_id` are Pinterest leftovers. They stay unused, and no migration drops them.

Schema changes: edit `src/db/schema.ts` → `npm run db:generate`. Past migrations only add tables, columns or indexes, each approved by the user. Ask before writing anything destructive.

## Tests

- `test/helpers.ts`: `api(path, init, overrides)` calls the app as a logged-in user (auth bypassed; `overrides` swaps bindings, e.g. a fake queue). `seed()` wipes the tables and creates Page 1 (enabled) and Page 2 (disabled). Add any new table to `seed()`'s delete list.
- `test/fetch-mock.ts`: `mockFetch({"METHOD origin/path": handler})` (query string ignored: branch on it inside the handler). An unmocked request throws, so tests never reach Facebook, Google or Claude. `ANTHROPIC_API_KEY` is deliberately not set in `vitest.config.ts`, so cron tests never call Claude; AI tests pass it via the `api()` overrides or a spread `env`.
- Fake secrets and Access vars are set in `vitest.config.ts`.

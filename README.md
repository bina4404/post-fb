# post-fb

Đăng bài theo lịch lên Facebook Page và Pinterest Board. Một Cloudflare Worker (Hono API + React SPA), dùng D1, R2, Cron, Queues và Cloudflare Access. Thiết kế chi tiết ở [PLAN.md](PLAN.md).

## Chạy local

Cần Node 24+.

```bash
npm install
cp .dev.vars.example .dev.vars   # điền giá trị, đặt DEV_AUTH_BYPASS=1 để bỏ qua Access trên localhost
npm run db:migrate:local         # tạo bảng trong D1 local (.wrangler/)
npm run build                    # build SPA vào dist/
npm run dev                      # Worker + SPA tại http://localhost:8787
```

Muốn sửa UI có hot reload thì chạy thêm `npm run dev:web` (Vite ở http://localhost:5173, tự proxy `/api` sang 8787).

## Lệnh

| Lệnh | Việc |
|---|---|
| `npm run typecheck` | sinh kiểu `Env` từ `wrangler.jsonc`, rồi `tsc` cho Worker và cho web |
| `npm run lint` | ESLint |
| `npm test` | Vitest chạy trong runtime Workers (`@cloudflare/vitest-plugin`), D1 local có migration |
| `npm run db:generate` | sửa `src/db/schema.ts` xong thì chạy lệnh này để sinh migration mới trong `migrations/` |

## Cấu trúc

- `src/`: Worker. `index.ts` là entry, `app.ts` là các route `/api/*`, `middleware/access.ts` kiểm JWT Cloudflare Access, `db/schema.ts` là schema Drizzle
- `web/`: React SPA (Vite + Tailwind)
- `migrations/`: SQL do drizzle-kit sinh ra, được áp dụng bằng `wrangler d1 migrations apply`
- `test/`: test

Secrets không bao giờ được commit. Local dùng `.dev.vars` (đã có trong .gitignore). Production dùng `wrangler secret put <TÊN>`.

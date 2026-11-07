# DEPLOY — checklist lên production

Làm theo thứ tự. Mọi lệnh có `--remote`, `wrangler deploy` hay `wrangler secret` đều tác động lên production, **bạn tự chạy**.

## 1. Cloudflare: tài nguyên

- [ ] Kiểm tra gói Workers. App dùng D1, R2, Queues và Cron. Mỗi lần import CSV tốn khoảng 2 câu lệnh D1/dòng, nên file 200 dòng cần giới hạn 1000 câu lệnh/request của **Workers Paid**. Gói Free (50 câu lệnh) chỉ đủ khoảng 20 dòng.
- [ ] Tạo tài nguyên:
  ```bash
  npx wrangler d1 create post-fb
  npx wrangler r2 bucket create post-fb-media
  npx wrangler queues create post-fb-publish
  ```
- [ ] Dán `database_id` thật vào `wrangler.jsonc` (thay `00000000-…`) rồi commit. `database_id` không phải secret.
- [ ] Chọn hostname, sửa `wrangler.jsonc`:
  - **Custom domain (khuyến nghị):** thêm `"routes": [{ "pattern": "post.example.com", "custom_domain": true }]`. Domain phải là zone trong tài khoản Cloudflare của bạn.
  - **`workers.dev`:** đặt `"workers_dev": true` và bật Access cho `*.workers.dev` (Workers → Settings → Domains & Routes → bật Cloudflare Access).
- [ ] Không bật `preview_urls`: URL preview nằm ngoài Access.

## 2. Cloudflare Access

- [ ] Zero Trust → Access → Applications → **Add → Self-hosted**, hostname là hostname ở bước 1.
- [ ] Policy **Allow** → Include → Emails: email của 1–5 người dùng.
- [ ] Copy **Application Audience (AUD) Tag** và **team domain** (`<team>.cloudflareaccess.com`).
- [ ] Điền vào `vars` trong `wrangler.jsonc`: `ACCESS_TEAM_DOMAIN` (không có `https://`) và `ACCESS_AUD`. Để trống thì mọi `/api/*` trả 403.

## 3. Meta (Facebook)

- [ ] developers.facebook.com → **Create App** → use case *Manage everything on your Page*.
- [ ] Facebook Login → Settings → Valid OAuth Redirect URIs: `https://<host>/api/oauth/facebook/callback` (khớp tuyệt đối).
- [ ] App roles: thêm từng người dùng làm Admin/Developer/Tester. Với người có vai trò trong app, quyền `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` dùng được ở Standard Access, **không cần App Review**.
- [ ] Chỉ khi cần người ngoài vai trò app dùng: Business Verification + App Review cho 3 quyền trên.
- [ ] Ghi lại App ID và App Secret.

## 4. Pinterest

- [ ] Dùng **tài khoản Business**. App tạo sau 14/09/2026 có thể bị `403 PINNER_DATA_ACCESS_DENIED` với tài khoản thường.
- [ ] developers.pinterest.com → **Create app** → Redirect URI: `https://<host>/api/oauth/pinterest/callback`.
- [ ] App mới ở mức **Trial**: Pin chỉ tạo được trên sandbox. Xin **Standard access** sớm (có thể cần video demo).
- [ ] Khi đã có Standard access: đổi `PINTEREST_API_BASE` trong `wrangler.jsonc` thành `https://api.pinterest.com/v5`. Đang là sandbox. Nếu bước đổi code OAuth bị lỗi trên sandbox, đổi sang production base để kết nối.

## 5. Secrets

```bash
openssl rand -base64 32   # giá trị cho TOKEN_ENC_KEY, cất ở password manager
npx wrangler secret put TOKEN_ENC_KEY
npx wrangler secret put FB_APP_ID
npx wrangler secret put FB_APP_SECRET
npx wrangler secret put PINTEREST_APP_ID
npx wrangler secret put PINTEREST_APP_SECRET
```

- [ ] **Không bao giờ** đặt `DEV_AUTH_BYPASS` trên production. Code chỉ cho bypass khi hostname là `localhost`, đây là lớp bảo vệ thứ hai.
- [ ] Đổi `TOKEN_ENC_KEY` sẽ làm mọi token đã lưu không giải mã được. Muốn đổi thì phải kết nối lại tất cả tài khoản.

## 6. GitHub + CI

- [ ] `git init`, kiểm tra `git status` **không** có `.dev.vars`, `.wrangler/`, `worker-configuration.d.ts`.
- [ ] Trước lần push đầu, quét secret:
  ```bash
  git log -p --all | grep -nE "EAA[A-Za-z0-9]{20,}|pina_[A-Za-z0-9]{20,}|pinr_[A-Za-z0-9]{20,}|TOKEN_ENC_KEY=.+" || echo "không thấy token"
  ```
- [ ] Push lên GitHub. Settings → Branches → bảo vệ `main`: bắt buộc check **CI / check** pass trước khi merge.

## 7. Workers Builds (deploy tự động khi push `main`)

- [ ] Workers & Pages → `post-fb` (tạo bằng lần deploy đầu, hoặc *Create → Import a repository*) → Settings → **Builds** → Connect repo, nhánh production `main`.
- [ ] Build command: `npm run build`
- [ ] Deploy command: `npx wrangler d1 migrations apply post-fb --remote && npx wrangler deploy`
- [ ] Build variables: không cần. Secrets nằm ở Worker, không nằm trong build.
- [ ] Nếu bước `migrations apply` báo thiếu quyền: Settings → Builds → API token → thêm quyền **D1 Edit**.
- [ ] Lần deploy đầu: xem log build, kiểm tra migration `0000_init.sql` được áp dụng.

## 8. Kiểm tra sau deploy

- [ ] Mở `https://<host>`: phải hiện trang đăng nhập Access. Đăng nhập xong thì email hiện ở góc phải.
- [ ] `curl -i https://<host>/api/me` không có cookie: phải trả **403** (hoặc trang login của Access).
- [ ] Tab **Tài khoản** → Kết nối Facebook → tick Page. Kết nối Pinterest → tick tài khoản và Board.
- [ ] Tab **Import CSV** → import 10 bài đặt giờ cách nhau vài phút.
- [ ] Tab **Lịch đăng** → bài chuyển `scheduled` → `published` trong ≤ 2 phút sau giờ hẹn, có link "Xem bài".
- [ ] Bài lỗi hiện lý do. Sửa nguyên nhân rồi bấm **Đăng lại**.
- [ ] Workers → Logs: có `cron_enqueued` và `publish_published`, không có token nào trong log.

## 9. Vận hành

- **Bài "Cần xử lý" với lỗi "không rõ kết quả":** kiểm tra trên Facebook/Pinterest xem bài đã lên chưa. Chỉ bấm Đăng lại nếu chưa lên.
- **"Tài khoản cần kết nối lại":** vào tab Tài khoản, kết nối lại. Bài đang chờ sẽ tự đi ở phút cron kế tiếp.
- **Rollback:** Workers → Deployments → chọn bản trước → *Rollback*, hoặc `npx wrangler rollback`. Migration không tự rollback.
- **Sửa schema:** sửa `src/db/schema.ts` → `npm run db:generate` → commit file migration mới. Workers Builds tự áp dụng khi deploy.

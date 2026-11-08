# DEPLOY — checklist lên production

Làm theo thứ tự. Mọi lệnh có `--remote`, `wrangler deploy` hay `wrangler secret` đều tác động lên production, **bạn tự chạy**.

## 1. Cloudflare: tài nguyên

- [ ] Kiểm tra gói Workers. App dùng D1, Queues và Cron. Ảnh lưu trên Google Drive. Mỗi lần import CSV tốn khoảng 2 câu lệnh D1/dòng, nên file 200 dòng cần giới hạn 1000 câu lệnh/request của **Workers Paid**. Gói Free (50 câu lệnh) chỉ đủ khoảng 20 dòng.
- [ ] Tạo tài nguyên:
  ```bash
  npx wrangler d1 create post-fb
  npx wrangler queues create post-fb-publish
  ```
- [ ] Dán `database_id` thật vào `wrangler.jsonc` (thay `00000000-…`) rồi commit. `database_id` không phải secret.
- [ ] Hostname: **`tools.new2h.com`** (đã cấu hình trong `wrangler.jsonc`: `"routes": [{ "pattern": "tools.new2h.com", "custom_domain": true }]`, `"workers_dev": false`). Zone `new2h.com` phải nằm trong cùng tài khoản Cloudflare; lần deploy đầu Cloudflare tự tạo DNS record và chứng chỉ cho `tools.new2h.com`. Nếu `tools.new2h.com` đã có DNS record khác (A/CNAME), xoá record đó trước, nếu không deploy sẽ lỗi.
- [ ] Không bật `preview_urls`: URL preview nằm ngoài Access.

## 2. Cloudflare Access

- [ ] Zero Trust → Access → Applications → mở app hiện có (AUD `58da…0c79`) → **Domains** → thêm `tools.new2h.com` → Save. Giữ cùng app thì AUD không đổi. Nếu tạo app mới (**Add → Self-hosted**, domain `tools.new2h.com`) thì AUD đổi, phải cập nhật `ACCESS_AUD`.
- [ ] Policy **Allow** → Include → Emails: email của 1–5 người dùng.
- [ ] Copy **Application Audience (AUD) Tag** và **team domain** (`<team>.cloudflareaccess.com`).
- [ ] Điền vào `vars` trong `wrangler.jsonc`: `ACCESS_TEAM_DOMAIN` (không có `https://`) và `ACCESS_AUD`. Để trống thì mọi `/api/*` trả 403.

## 3. Meta (Facebook)

- [ ] developers.facebook.com → **Create App** → use case *Manage everything on your Page*.
- [ ] Facebook Login → Settings → Valid OAuth Redirect URIs: `https://tools.new2h.com/api/oauth/facebook/callback` (khớp tuyệt đối).
- [ ] App roles: thêm từng người dùng làm Admin/Developer/Tester. Với người có vai trò trong app, quyền `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `business_management` dùng được ở Standard Access, **không cần App Review**.
- [ ] Use cases → *Manage everything on your Page* → **Customize** → thêm quyền **`business_management`**. Thiếu quyền này, Facebook không liệt kê các Page bạn quản lý qua Business Portfolio (Meta Business Suite) và app chỉ thấy 0–1 Page.
- [ ] Chỉ khi cần người ngoài vai trò app dùng: Business Verification + App Review cho 3 quyền trên.
- [ ] Ghi lại App ID và App Secret.

## 4b. Google Drive (lưu ảnh)

- [ ] console.cloud.google.com → tạo project → **APIs & Services → Library** → bật **Google Drive API**.
- [ ] **OAuth consent screen**: User type *External*, thêm scope `.../auth/drive.file`, thêm email của bạn vào *Test users*.
- [ ] **Bắt buộc: bấm *Publish app* (chuyển sang *In production*).** Khi app còn ở *Testing*, refresh token của Google **hết hạn sau 7 ngày** và bạn sẽ phải kết nối lại mỗi tuần. `drive.file` là scope không nhạy cảm nên không cần Google xét duyệt; màn hình đồng ý có thể hiện cảnh báo "chưa xác minh", bấm tiếp tục.
- [ ] **Credentials → Create credentials → OAuth client ID → Web application**. Authorized redirect URIs:
  - `https://tools.new2h.com/api/oauth/google/callback`
  - `http://localhost:8787/api/oauth/google/callback` (để chạy local)
- [ ] Ghi lại Client ID và Client secret.
- [ ] Sau deploy: tab **Tài khoản → Kết nối Google Drive**. Chưa kết nối thì upload ảnh báo lỗi. Ảnh nằm trong thư mục **`post-fb`** ở My Drive (app tự tạo ở lần upload đầu). App chỉ thấy file do chính nó tạo (scope `drive.file`): ảnh bạn tự kéo vào thư mục đó trên Drive sẽ **không** hiện trong "Chọn từ Google Drive", hãy upload qua app.

## 5. Secrets

```bash
openssl rand -base64 32   # giá trị cho TOKEN_ENC_KEY, cất ở password manager
npx wrangler secret put TOKEN_ENC_KEY
npx wrangler secret put FB_APP_ID
npx wrangler secret put FB_APP_SECRET
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
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

- [ ] Mở `https://tools.new2h.com`: phải hiện trang đăng nhập Access. Đăng nhập xong thì email hiện ở góc phải.
- [ ] `curl -i https://tools.new2h.com/api/me` không có cookie: phải trả **403** (hoặc trang login của Access).
- [ ] Tab **Tài khoản** → Kết nối Google Drive → Kết nối Facebook → tick Page.
- [ ] Tab **Import CSV** → import 10 bài đặt giờ cách nhau vài phút.
- [ ] Tab **Lịch đăng** → bài chuyển `scheduled` → `published` trong ≤ 2 phút sau giờ hẹn, có link "Xem bài".
- [ ] Bài lỗi hiện lý do. Sửa nguyên nhân rồi bấm **Đăng lại**.
- [ ] Workers → Logs: có `cron_enqueued` và `publish_published`, không có token nào trong log.

## 9. Vận hành

- **Nhịp đăng (giảm rủi ro bị Facebook hạn chế):** app tự giãn ≥10 phút giữa 2 bài trên cùng Page, tối đa 25 bài/Page/24 giờ, và giãn 30–90 giây giữa các Page khi đăng cùng một nội dung. Bài chưa tới lượt vẫn ở trạng thái `scheduled` và tự đi sau. Đổi các con số này ở `src/lib/pacing.ts`.
- **"Facebook tạm chặn Page này":** Facebook trả mã 368 (nghi lạm dụng). App dừng đăng lên Page đó. Kiểm tra thông báo trong Meta Business Suite / Page Quality, sửa nội dung vi phạm, rồi vào tab Tài khoản bấm **Kết nối Facebook** để chạy lại; bài lỗi bấm **Đăng lại**.

- **Bài "Cần xử lý" với lỗi "không rõ kết quả":** kiểm tra trên Page Facebook xem bài đã lên chưa. Chỉ bấm Đăng lại nếu chưa lên.
- **"Tài khoản cần kết nối lại":** vào tab Tài khoản, kết nối lại. Bài đang chờ sẽ tự đi ở phút cron kế tiếp.
- **Rollback:** Workers → Deployments → chọn bản trước → *Rollback*, hoặc `npx wrangler rollback`. Migration không tự rollback.
- **Migration hiện có:** `0000_init` (bảng) và `0001_library_indexes` (chỉ thêm index). Lệnh deploy của Workers Builds tự áp dụng migration mới trước khi deploy.
- **Sửa schema:** sửa `src/db/schema.ts` → `npm run db:generate` → commit file migration mới. Workers Builds tự áp dụng khi deploy.

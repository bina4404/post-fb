// Adapter duy nhất gọi Claude API (viết caption và bài hỏi fan). Tài liệu: platform.claude.com/docs
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { platformError } from "./errors";

export const CLAUDE_MODEL = "claude-opus-5-5";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/**
 * Văn phong rút từ báo cáo phân tích page (10/11/2026): khán giả nói tiếng Anh (55,8% ở Mỹ), 25–54 tuổi, đến từ tab Reels;
 * 4 Reels đỉnh đều mở bằng câu hỏi; kể theo khung "thuyết này từ đâu ra và bằng chứng nói gì" để không đăng tin sai.
 */
const STYLE_GUIDE = `You write Facebook posts for a mystery page. The audience speaks English: mostly the US, then the Philippines and the UK, aged 25-54, and most of them find the page through Reels, not the feed.
What measurably works on this page: a direct question as the hook ("What really happened to...?", "Is ... actually ...?"), the most surprising concrete detail early, short plain sentences, and an ending that invites believers and skeptics to argue in the comments.
Rules:
- Write in English.
- Put the hook question in the first line.
- Frame every theory as "where this theory comes from and what the evidence actually says". Never present an unproven theory, death hoax or conspiracy as fact.
- Never invent quotes, dates, numbers, people or sources. If you are not sure of a fact, leave it out.
- No promises the post does not deliver, no fear-mongering, no medical, legal or financial advice.
- Each post must be clearly different from the others and from any existing post you are shown.`;

const Output = z.object({ posts: z.array(z.string()) });

export type WriteRequest = {
  /** Việc cụ thể: chủ đề, loại bài, số bài, độ dài. */
  task: string;
  image?: { bytes: Uint8Array; contentType: string } | null;
};

function base64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Gọi Claude viết bài theo STYLE_GUIDE. Trả về danh sách bài (chuỗi đã trim, bỏ chuỗi rỗng). */
export async function writePosts(apiKey: string, req: WriteRequest): Promise<string[]> {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (req.image && IMAGE_TYPES.has(req.image.contentType)) {
    content.push({ type: "image", source: { type: "base64", media_type: req.image.contentType as "image/jpeg", data: base64(req.image.bytes) } });
  }
  content.push({ type: "text", text: req.task });

  let res;
  try {
    res = await client.beta.messages.parse({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      // Bị từ chối (chủ đề thuyết âm mưu có thể chạm bộ lọc) thì API tự chạy lại trên model dự phòng.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(Output) },
      system: STYLE_GUIDE,
      messages: [{ role: "user", content }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      const status = err.status ?? 0;
      const kind = status === 429 ? "rate_limited" : status === 401 || status === 403 ? "auth" : status >= 500 || status === 0 ? "transient" : "permanent";
      throw platformError("anthropic", "write_posts", kind, status, null, err.message);
    }
    throw err;
  }
  if (res.stop_reason === "refusal") throw platformError("anthropic", "write_posts", "permanent", 200, "refusal", "Claude từ chối viết bài cho nội dung này");
  if (!res.parsed_output) throw platformError("anthropic", "write_posts", "transient", 200, res.stop_reason ?? null, "Claude trả về kết quả không đọc được");
  return res.parsed_output.posts.map((p) => p.trim()).filter(Boolean);
}

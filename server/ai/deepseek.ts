/**
 * Client tối giản cho DeepSeek Chat Completions (tương thích OpenAI).
 * Key đọc từ .env: DEEPSEEK_API_KEY (bắt buộc), DEEPSEEK_MODEL (mặc định deepseek-v4-pro), DEEPSEEK_BASE_URL.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const ENV_FILE = join(ROOT, ".env");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export class AiError extends Error {}

export function aiConfigured(): boolean {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

export async function chatJson(messages: ChatMessage[], opts: { maxTokens?: number; timeoutMs?: number; temperature?: number } = {}): Promise<ChatResult> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new AiError("Chưa cấu hình DEEPSEEK_API_KEY trong file .env");
  const base = (process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com").replace(/\/$/, "");
  const model = process.env.DEEPSEEK_MODEL ?? "deepseek-v4-pro";

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      response_format: { type: "json_object" },
      max_tokens: opts.maxTokens ?? 16000,
      temperature: opts.temperature ?? 0.8,
    }),
    // Model suy luận có thể mất vài phút với kịch bản nhiều cảnh + đồ vật; chỉnh bằng DEEPSEEK_TIMEOUT_MS.
    signal: AbortSignal.timeout(opts.timeoutMs ?? (Number(process.env.DEEPSEEK_TIMEOUT_MS) || 420_000)),
  }).catch((err: unknown) => {
    throw new AiError(`Không gọi được DeepSeek: ${err instanceof Error ? err.message : String(err)}`);
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 400);
    try {
      msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* giữ nguyên */
    }
    throw new AiError(`DeepSeek lỗi ${res.status}: ${msg}`);
  }
  const data = JSON.parse(text) as { model: string; usage?: ChatResult["usage"]; choices: { message: { content: string }; finish_reason: string }[] };
  const choice = data.choices[0];
  if (!choice?.message.content) throw new AiError("DeepSeek trả về rỗng");
  if (choice.finish_reason === "length") throw new AiError("Kịch bản quá dài (vượt giới hạn token) – thử prompt ngắn hơn");
  return { content: choice.message.content, model: data.model, usage: data.usage };
}

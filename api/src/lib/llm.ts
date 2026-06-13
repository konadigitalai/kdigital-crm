// Minimal Anthropic Messages API client. Works with the public Anthropic
// endpoint AND the NVIDIA-hosted gateway (which speaks the same wire protocol).
//
// Reads ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL from env.
// No SDK — keeps the dependency surface small and the wire format transparent.

const DEFAULT_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

export interface CallClaudeOpts {
  system: string;
  user: string;
  /** When set, the result is parsed as JSON and returned in `jsonValue`. */
  expectJson?: boolean;
  maxTokens?: number;
  /** Override the env model (rare). */
  model?: string;
}

export interface ClaudeResult {
  text: string;
  jsonValue?: unknown;
  usage: { in: number; out: number };
  model: string;
}

interface MessagesResponse {
  content: Array<{ type: string; text?: string }>;
  model: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pickJson(text: string): unknown {
  // Models occasionally wrap JSON in ```json … ``` even when told not to.
  // Strip the fence, then attempt parse.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1]! : text).trim();
  return JSON.parse(raw);
}

export async function callClaude(opts: CallClaudeOpts): Promise<ClaudeResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in env.");
  const baseRaw = process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE;
  const base = baseRaw.replace(/\/+$/, "");
  const model = opts.model ?? process.env.ANTHROPIC_MODEL;
  if (!model) throw new Error("ANTHROPIC_MODEL is not set in env.");

  const system = opts.expectJson
    ? `${opts.system}\n\nRespond with ONLY valid JSON. No prose, no code fences, no markdown.`
    : opts.system;

  const body = {
    model,
    max_tokens: opts.maxTokens ?? 1024,
    system,
    messages: [{ role: "user", content: opts.user }],
  };

  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      });
      if (res.status === 429 || res.status >= 500) {
        // Retry transient errors with exponential backoff.
        const delay = 500 * 2 ** attempt;
        await sleep(delay);
        lastError = new Error(`Claude ${res.status}: ${await res.text()}`);
        continue;
      }
      if (!res.ok) {
        throw new Error(`Claude ${res.status}: ${await res.text()}`);
      }
      const json = (await res.json()) as MessagesResponse;
      const text = (json.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("")
        .trim();
      const usage = {
        in: json.usage?.input_tokens ?? 0,
        out: json.usage?.output_tokens ?? 0,
      };
      const result: ClaudeResult = { text, usage, model: json.model ?? model };
      if (opts.expectJson) {
        try {
          result.jsonValue = pickJson(text);
        } catch (err) {
          throw new Error(`Claude returned non-JSON: ${(err as Error).message} | got: ${text.slice(0, 200)}`);
        }
      }
      return result;
    } catch (err) {
      lastError = err as Error;
      // Non-transient failures (parse errors etc.) — bail.
      if (!/Claude (429|5\d\d)/.test(lastError.message)) break;
    }
  }
  throw lastError ?? new Error("callClaude failed");
}

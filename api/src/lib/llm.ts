// LangChain ChatAnthropic factory + a thin compatibility shim that mirrors the
// previous fetch-based callClaude() API. Reads ANTHROPIC_API_KEY,
// ANTHROPIC_BASE_URL (the NVIDIA-hosted gateway speaks Anthropic's wire
// protocol), and ANTHROPIC_MODEL from env.

import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";

export interface MakeChatModelOpts {
  maxTokens?: number;
  /** Override the env model (rare). */
  model?: string;
}

export function makeChatModel(opts: MakeChatModelOpts = {}): ChatAnthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set in env.");
  const model = opts.model ?? process.env.ANTHROPIC_MODEL;
  if (!model) throw new Error("ANTHROPIC_MODEL is not set in env.");
  const anthropicApiUrl = process.env.ANTHROPIC_BASE_URL?.replace(/\/+$/, "");

  return new ChatAnthropic({
    apiKey,
    model,
    maxTokens: opts.maxTokens ?? 1024,
    ...(anthropicApiUrl ? { anthropicApiUrl } : {}),
    // Modest backoff; LangChain handles 429/5xx retry logic internally.
    maxRetries: 3,
  });
}

// ─── Compatibility shim ───────────────────────────────────────────────────
//
// The previous fetch-based client returned { text, jsonValue, usage, model }.
// `edify.ts` and the agent bodies still reach for this shape. We keep the
// helper so call sites don't need to change wire when they're only doing a
// single-shot prompt.

export interface CallClaudeOpts extends MakeChatModelOpts {
  system: string;
  user: string;
  /** When set, the result is parsed as JSON and returned in `jsonValue`. */
  expectJson?: boolean;
}

export interface ClaudeResult {
  text: string;
  jsonValue?: unknown;
  usage: { in: number; out: number };
  model: string;
}

function pickJson(text: string): unknown {
  // Models occasionally wrap JSON in ```json … ``` even when told not to.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1]! : text).trim();
  return JSON.parse(raw);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          const t = (part as { text?: unknown }).text;
          return typeof t === "string" ? t : "";
        }
        return "";
      })
      .join("");
  }
  return "";
}

export async function callClaude(opts: CallClaudeOpts): Promise<ClaudeResult> {
  const model = makeChatModel({ maxTokens: opts.maxTokens, model: opts.model });
  const system = opts.expectJson
    ? `${opts.system}\n\nRespond with ONLY valid JSON. No prose, no code fences, no markdown.`
    : opts.system;

  const res = await model.invoke([
    new SystemMessage(system),
    new HumanMessage(opts.user),
  ]);

  const text = extractText(res.content).trim();
  const usageMeta = res.usage_metadata;
  const usage = {
    in: usageMeta?.input_tokens ?? 0,
    out: usageMeta?.output_tokens ?? 0,
  };
  // ChatAnthropic populates response_metadata.model with the resolved model id.
  const resolvedModel =
    (res.response_metadata as { model?: string } | undefined)?.model ??
    opts.model ??
    process.env.ANTHROPIC_MODEL!;

  const result: ClaudeResult = { text, usage, model: resolvedModel };
  if (opts.expectJson) {
    try {
      result.jsonValue = pickJson(text);
    } catch (err) {
      throw new Error(
        `Claude returned non-JSON: ${(err as Error).message} | got: ${text.slice(0, 200)}`,
      );
    }
  }
  return result;
}

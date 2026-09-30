// The eight-question summary for one brand profile (zw14): one model call turns the collected
// encyclopedia text plus the reviewed seed facts into the eight short answers and a ≤50-character
// Chinese summary. A summary over the hard 50-character cap is asked for once more; still too long
// (or rejected) leaves the row failed with the reason, never a truncated or invented text.
import { z } from "zod";
import { chatJson } from "../providers/llm.ts";
import { ProviderRejectedError } from "../providers/receipts.ts";
import { modelFor } from "../editorial/models.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";
import { SITE } from "@aihot/industry/site";
import { shutdownSignal } from "../jobs/queue.ts";
import type { CollectedProfile } from "./collect.ts";

export const BRAND_PROFILE_PROMPT_VERSION = promptVersion("brand-profile");

const SYSTEM = promptText("brand-profile", { siteName: SITE.name });

/** 50 Chinese characters, punctuation included, spaces excluded — the owner's literal cap. */
const SUMMARY_MAX_CHARS = 50;

const summaryLength = (s: string) => [...s.replace(/\s/g, "")].length;

const Answer = z.object({
  origin: z.string().nullable(),
  channels: z.string().nullable(),
  audience: z.string().nullable(),
  priceRange: z.string().nullable(),
  mainCategory: z.string().nullable(),
  scale: z.string().nullable(),
  philosophy: z.string().nullable(),
  strength: z.string().nullable(),
  foundedYear: z.number().int().nullable(),
  listedAt: z.string().nullable(),
  summary: z.string().min(10),
});

export interface SummaryOutcome {
  ok: boolean;
  fields: {
    origin: string | null;
    channels: string | null;
    audience: string | null;
    priceRange: string | null;
    mainCategory: string | null;
    scale: string | null;
    philosophy: string | null;
    strength: string | null;
    foundedYear: number | null;
    listedAt: string | null;
    summary: string;
    summaryChars: number;
  } | null;
  model: string;
  receiptId: number | null;
  error: string | null;
}

async function callModel(collected: CollectedProfile, attemptTag?: string) {
  const model = await modelFor("brandProfile");
  const user = `品牌：${collected.name}\n\n档案材料：\n${collected.sourceText}`;
  return chatJson({
    model,
    purpose: "brand_profile",
    subject: collected.slug,
    promptVersion: BRAND_PROFILE_PROMPT_VERSION,
    system: SYSTEM,
    user,
    schema: Answer,
    temperature: 0.2,
    // Generous on purpose: on the Anthropic endpoint the visible thinking spends output tokens
    // before the JSON (it cannot be switched off there), and a cap that bites mid-answer leaves
    // no parseable object at all.
    maxTokens: 4000,
    attemptTag,
  });
}

/** Summarise one collected profile. A retryable provider rejection (429/5xx, common while the
 *  analysis queue is draining the same key) backs off and tries again; an over-cap summary gets
 *  exactly one re-ask. Everything else fails the row — the next refresh round retries it. */
export async function summarizeBrand(collected: CollectedProfile): Promise<SummaryOutcome> {
  let last: Awaited<ReturnType<typeof callModel>> | null = null;
  let lastError: string | null = null;
  let reasked = false;
  for (let attempt = 1; attempt <= 4 && !shutdownSignal.signal.aborted; attempt++) {
    if (attempt > 1) {
      // Backoff long enough to let the concurrent analysis calls drain the shared rate limit.
      const wait = 25_000 * (attempt - 1);
      if (!(await sleepInterruptible(wait))) break;
    }
    try {
      const res = await callModel(collected, attempt === 1 ? undefined : "retry");
      const a = res.data;
      const chars = summaryLength(a.summary);
      if (chars > SUMMARY_MAX_CHARS) {
        if (reasked) {
          last = res;
          lastError = `summary ${chars} 字超 ${SUMMARY_MAX_CHARS} 字上限`;
          break;
        }
        reasked = true;
        last = res;
        lastError = `summary ${chars} 字超 ${SUMMARY_MAX_CHARS} 字上限（重问一次）`;
        continue;
      }
      return {
        ok: true,
        fields: {
          origin: a.origin, channels: a.channels, audience: a.audience, priceRange: a.priceRange,
          mainCategory: a.mainCategory, scale: a.scale, philosophy: a.philosophy, strength: a.strength,
          foundedYear: a.foundedYear, listedAt: a.listedAt,
          summary: a.summary, summaryChars: chars,
        },
        model: res.model,
        receiptId: res.receiptId,
        error: null,
      };
    } catch (error) {
      lastError = String(error).slice(0, 300);
      // Non-retryable rejections (auth, content filter) burn no further attempts.
      if (error instanceof ProviderRejectedError && !error.retryable) break;
    }
  }
  return { ok: false, fields: null, model: last?.model ?? "unknown", receiptId: last?.receiptId ?? null, error: lastError };
}

/** Sleep that a shutdown interrupts; resolves false when it did. */
function sleepInterruptible(ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      shutdownSignal.signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    if (shutdownSignal.signal.aborted) onAbort();
    else shutdownSignal.signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Pixels -> a verdict. The one place a score becomes a decision.

import type { Config, NsfwClass } from "../config.ts";
import { decode, resize, UnsupportedFormatError } from "./decode.ts";
import { getModel, lastLoadMs } from "./model.ts";

export const MODEL_INPUT_SIZE = 224;

export type Scores = Partial<Record<NsfwClass, number>>;

export interface Classification {
  scores: Scores;
  /** The highest score among NSFW_CLASSES. */
  score: number;
  /** Which of NSFW_CLASSES produced it. */
  topClass: NsfwClass;
}

export type ClassifyOutcome =
  | {
    ok: true;
    classification: Classification;
    ms: { decode: number; classify: number; modelLoad: number };
  }
  | {
    ok: false;
    reason: "unsupported_format" | "decode_failed" | "model_failed" | "classify_failed";
    detail: string;
  };

/**
 * `max` over the selected classes rather than a sum, so adding a class to
 * NSFW_CLASSES cannot flag an image purely by accumulating small unrelated
 * probabilities.
 */
export function scoreOf(
  scores: Scores,
  classes: NsfwClass[],
): { score: number; topClass: NsfwClass } {
  let score = 0;
  let topClass = classes[0];
  for (const name of classes) {
    const value = scores[name] ?? 0;
    if (value > score) {
      score = value;
      topClass = name;
    }
  }
  return { score, topClass };
}

export function isFlagged(score: number, threshold: number): boolean {
  return score >= threshold;
}

export async function classifyImage(bytes: Uint8Array, config: Config): Promise<ClassifyOutcome> {
  const decodeStarted = Date.now();
  let pixels;
  try {
    pixels = resize(await decode(bytes), MODEL_INPUT_SIZE);
  } catch (e) {
    if (e instanceof UnsupportedFormatError) {
      return { ok: false, reason: "unsupported_format", detail: e.format };
    }
    return {
      ok: false,
      reason: "decode_failed",
      detail: String(e instanceof Error ? e.message : e),
    };
  }
  const decodeMs = Date.now() - decodeStarted;

  let loaded;
  try {
    loaded = await getModel(config);
  } catch (e) {
    return {
      ok: false,
      reason: "model_failed",
      detail: String(e instanceof Error ? e.message : e),
    };
  }

  const { tf, model } = loaded;
  const classifyStarted = Date.now();
  // deno-lint-ignore no-explicit-any
  let input: any = null;
  try {
    input = tf.tensor3d(pixels.data, [MODEL_INPUT_SIZE, MODEL_INPUT_SIZE, 3], "int32");
    const predictions = await model.classify(input);
    const scores: Scores = {};
    for (const p of predictions as Array<{ className: NsfwClass; probability: number }>) {
      scores[p.className] = p.probability;
    }
    const { score, topClass } = scoreOf(scores, config.nsfwClasses);
    return {
      ok: true,
      classification: { scores, score, topClass },
      ms: { decode: decodeMs, classify: Date.now() - classifyStarted, modelLoad: lastLoadMs },
    };
  } catch (e) {
    return {
      ok: false,
      reason: "classify_failed",
      detail: String(e instanceof Error ? e.message : e),
    };
  } finally {
    // Explicit disposal: a leaked tensor on a long-lived warm isolate is a slow
    // memory climb that ends with the isolate killed mid-request.
    input?.dispose?.();
  }
}

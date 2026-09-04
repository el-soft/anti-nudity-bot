// The one test that loads the model and runs a real classification. Slow (it
// fetches the WASM backend and the weights), so it is kept separate:
//
//   deno test --allow-net --allow-env --allow-read tests/classify_integration_test.ts
//
// It exists because ARCHITECTURE.md open question 1 — "does this stack actually
// run outside Node?" — is the assumption the whole Edge path rests on.

import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import jpeg from "jpeg-js";
import { parseConfig } from "../src/config.ts";
import { classifyImage } from "../src/detector/classify.ts";
import { decode, sniffFormat } from "../src/detector/decode.ts";

const config = parseConfig((key) =>
  ({
    TELEGRAM_BOT_TOKEN: "1:a",
    TELEGRAM_WEBHOOK_SECRET: "s".repeat(32),
    ALLOWED_CHAT_IDS: "-100",
  } as Record<string, string>)[key]
).config;

/** A synthetic gradient, encoded the way Telegram encodes photos. */
function syntheticJpeg(width = 320, height = 240): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = (x / width) * 255;
      rgba[i + 1] = (y / height) * 255;
      rgba[i + 2] = 128;
      rgba[i + 3] = 255;
    }
  }
  return new Uint8Array(jpeg.encode({ data: rgba, width, height }, 85).data);
}

Deno.test("a real JPEG round-trips through the sniffer and the decoder", async () => {
  const bytes = syntheticJpeg();
  assertEquals(sniffFormat(bytes), "jpeg");
  const image = await decode(bytes);
  assertEquals(image.width, 320);
  assertEquals(image.height, 240);
  assertEquals(image.data.length, 320 * 240 * 3);
});

Deno.test("the classifier loads and returns a full score vector", async () => {
  const outcome = await classifyImage(syntheticJpeg(), config);
  assert(
    outcome.ok,
    outcome.ok ? "" : `classification failed: ${outcome.reason} ${outcome.detail}`,
  );

  const { scores, score, topClass } = outcome.classification;
  const total = Object.values(scores).reduce((sum, value) => sum + value, 0);
  assertAlmostEquals(total, 1, 0.01, "nsfwjs scores should sum to ~1");
  assert(config.nsfwClasses.includes(topClass));
  assert(score >= 0 && score <= 1);

  // A gradient is not explicit. This is a sanity check on the wiring, not an
  // accuracy claim about the model.
  assert(score < config.nsfwThreshold, `a gradient scored ${score}`);
});

Deno.test("bytes that are not an image are unsupported, never clean", async () => {
  const outcome = await classifyImage(new TextEncoder().encode("not an image at all"), config);
  assert(!outcome.ok);
  assertEquals(outcome.reason, "unsupported_format");
});

// Bytes -> a 224x224 RGB buffer, without a filesystem, native bindings or canvas.
//
// The format is decided by sniffing magic bytes, never by the declared MIME type:
// documents are pass-through and unre-encoded, so a `image/jpeg` label on a WEBP
// (or on something that isn't an image at all) is trivially forged.

export type ImageFormat = "jpeg" | "png" | "gif" | "webp" | "bmp" | "unknown";

export interface RgbImage {
  data: Uint8Array; // RGB, 3 bytes per pixel
  width: number;
  height: number;
}

export class UnsupportedFormatError extends Error {
  constructor(public format: ImageFormat) {
    super(`unsupported_format: ${format}`);
    this.name = "UnsupportedFormatError";
  }
}

export function sniffFormat(bytes: Uint8Array): ImageFormat {
  if (bytes.length < 12) return "unknown";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "gif";
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return "bmp";
  return "unknown";
}

/**
 * The platform decoder, when the runtime has one. If `ImageDecoder` is available
 * at the edge it handles every format including WEBP, and the hand-rolled
 * decoders below become a fallback rather than the main path.
 */
async function decodeWithPlatform(
  bytes: Uint8Array,
  format: ImageFormat,
): Promise<RgbImage | null> {
  // deno-lint-ignore no-explicit-any
  const Decoder = (globalThis as any).ImageDecoder;
  if (typeof Decoder !== "function") return null;
  const mime = {
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    unknown: "",
  }[format];
  if (!mime) return null;
  try {
    if (typeof Decoder.isTypeSupported === "function" && !(await Decoder.isTypeSupported(mime))) {
      return null;
    }
    const decoder = new Decoder({ data: bytes, type: mime });
    const { image } = await decoder.decode();
    const width = image.displayWidth ?? image.codedWidth;
    const height = image.displayHeight ?? image.codedHeight;
    const rgba = new Uint8Array(width * height * 4);
    await image.copyTo(rgba, { format: "RGBA" });
    image.close?.();
    decoder.close?.();
    return { data: rgbaToRgb(rgba, width * height), width, height };
  } catch {
    return null;
  }
}

/** Flattens RGBA onto white; nsfwjs takes three channels. */
function rgbaToRgb(rgba: Uint8Array | Uint8ClampedArray, pixels: number): Uint8Array {
  const rgb = new Uint8Array(pixels * 3);
  for (let i = 0; i < pixels; i++) {
    const alpha = rgba[i * 4 + 3] / 255;
    // Compositing on white rather than dropping alpha outright: a transparent
    // PNG otherwise decodes to whatever garbage sits in the colour channels.
    rgb[i * 3] = Math.round(rgba[i * 4] * alpha + 255 * (1 - alpha));
    rgb[i * 3 + 1] = Math.round(rgba[i * 4 + 1] * alpha + 255 * (1 - alpha));
    rgb[i * 3 + 2] = Math.round(rgba[i * 4 + 2] * alpha + 255 * (1 - alpha));
  }
  return rgb;
}

async function decodeJpeg(bytes: Uint8Array): Promise<RgbImage> {
  const jpeg = await import("jpeg-js");
  const decode = jpeg.decode ?? jpeg.default?.decode;
  const raw = decode(bytes, { useTArray: true, maxMemoryUsageInMB: 256, formatAsRGBA: true });
  return {
    data: rgbaToRgb(raw.data, raw.width * raw.height),
    width: raw.width,
    height: raw.height,
  };
}

async function decodePng(bytes: Uint8Array): Promise<RgbImage> {
  const upng = await import("upng-js");
  const api = upng.default ?? upng;
  const image = api.decode(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const frames = api.toRGBA8(image);
  const rgba = new Uint8Array(frames[0]);
  return {
    data: rgbaToRgb(rgba, image.width * image.height),
    width: image.width,
    height: image.height,
  };
}

/**
 * Decode to RGB. Throws `UnsupportedFormatError` for anything the runtime cannot
 * read — which is logged as `unsupported_format` and never treated as "clean".
 */
export async function decode(bytes: Uint8Array): Promise<RgbImage> {
  const format = sniffFormat(bytes);

  const viaPlatform = await decodeWithPlatform(bytes, format);
  if (viaPlatform) return viaPlatform;

  switch (format) {
    case "jpeg":
      return await decodeJpeg(bytes);
    case "png":
      return await decodePng(bytes);
    default:
      // WEBP (static stickers) and GIF land here without a platform decoder.
      // extract.ts prefers Telegram's JPEG thumbnail for exactly this reason.
      throw new UnsupportedFormatError(format);
  }
}

/**
 * Bilinear resize to the model's square input. Bilinear rather than nearest
 * because avatars arrive small and nearest-neighbour aliasing on a 224px target
 * visibly moves classifier scores.
 */
export function resize(image: RgbImage, size: number): RgbImage {
  const { data, width, height } = image;
  const out = new Uint8Array(size * size * 3);
  const xRatio = width / size;
  const yRatio = height / size;

  for (let y = 0; y < size; y++) {
    // Clamped at both ends: without the lower clamp the first row and column
    // get a negative weight and extrapolate past the edge pixel.
    const srcY = Math.min(height - 1, Math.max(0, (y + 0.5) * yRatio - 0.5));
    const y0 = Math.max(0, Math.floor(srcY));
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = srcY - y0;

    for (let x = 0; x < size; x++) {
      const srcX = Math.min(width - 1, Math.max(0, (x + 0.5) * xRatio - 0.5));
      const x0 = Math.max(0, Math.floor(srcX));
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = srcX - x0;

      for (let c = 0; c < 3; c++) {
        const p00 = data[(y0 * width + x0) * 3 + c];
        const p01 = data[(y0 * width + x1) * 3 + c];
        const p10 = data[(y1 * width + x0) * 3 + c];
        const p11 = data[(y1 * width + x1) * 3 + c];
        const top = p00 + (p01 - p00) * wx;
        const bottom = p10 + (p11 - p10) * wx;
        out[(y * size + x) * 3 + c] = Math.round(top + (bottom - top) * wy);
      }
    }
  }

  return { data: out, width: size, height: size };
}

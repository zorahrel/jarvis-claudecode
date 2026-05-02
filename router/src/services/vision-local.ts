/**
 * Local vision service — bridges to Moondream Station on :2020.
 *
 * Runs Moondream 3 Preview MLX natively on Apple Silicon, fully offline.
 * Use this instead of mailing screenshots to a cloud VLM when you want:
 *   - sub-cloud latency (single-digit seconds end-to-end on M-series)
 *   - zero token cost on the hot path
 *   - privacy: nothing leaves the device
 *
 * The daemon is supervised by launchd (com.jarvis.moondream); see
 * scripts/moondream-server.py for the boot path. If the daemon is down,
 * every function returns a structured error rather than throwing — the
 * caller decides whether to fall back to a cloud VLM (Claude vision) or
 * surface "vision unavailable" to the user.
 */
import { readFileSync } from "fs";
import { extname } from "path";
import { logger } from "./logger";

const log = logger.child({ module: "vision-local" });

const VISION_URL = process.env.VISION_LOCAL_URL || "http://localhost:2020";
const DEFAULT_TIMEOUT_MS = 60_000;

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type VisionError = { error: string };
export type VisionOk<T> = T & { _stats?: { tokens: number; duration: number; tokens_per_sec: number } };
export type VisionResult<T> = VisionOk<T> | VisionError;

export interface CaptionResult { caption: string }
export interface QueryResult { answer: string }
export interface DetectResult { objects: { x_min: number; y_min: number; x_max: number; y_max: number }[] }
export interface PointResult { points: { x: number; y: number }[] }

function imageToDataUrl(filePath: string): string | null {
  try {
    const buf = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mime = MIME_BY_EXT[ext] ?? "image/jpeg";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch (err) {
    log.error({ err, filePath }, "vision-local: failed to read image");
    return null;
  }
}

/**
 * Resolve a caller-provided image to a data URL. Accepts:
 *   - absolute file path (read from disk)
 *   - already-prefixed data URL (passed through)
 *   - http(s) URL (passed through; Moondream Station fetches it)
 */
function resolveImage(image: string): string | null {
  if (image.startsWith("data:")) return image;
  if (image.startsWith("http://") || image.startsWith("https://")) return image;
  return imageToDataUrl(image);
}

async function postJson<T>(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<VisionResult<T>> {
  const url = `${VISION_URL}${path}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { error: `vision-local ${path}: HTTP ${res.status}` };
    }
    const data = (await res.json()) as VisionResult<T>;
    if ("error" in data && data.error) {
      log.warn({ path, error: data.error }, "vision-local error response");
    }
    return data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ path, err: msg }, "vision-local request failed");
    return { error: `vision-local ${path}: ${msg}` };
  }
}

/** GET /health — returns true if the daemon is reachable. */
export async function isAvailable(timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`${VISION_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * caption(image, length): natural-language description of the image.
 * `length` is "short" | "normal" | "long" — Moondream tunes verbosity.
 */
export async function caption(
  image: string,
  length: "short" | "normal" | "long" = "normal",
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<VisionResult<CaptionResult>> {
  const resolved = resolveImage(image);
  if (!resolved) return { error: "vision-local: cannot read image" };
  return postJson<CaptionResult>("/v1/caption", { image_url: resolved, length, timeout: timeoutMs / 1000 }, timeoutMs);
}

/** query(image, question): VQA — free-form Q&A grounded on the image. */
export async function query(
  image: string,
  question: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<VisionResult<QueryResult>> {
  const resolved = resolveImage(image);
  if (!resolved) return { error: "vision-local: cannot read image" };
  return postJson<QueryResult>("/v1/query", { image_url: resolved, question, timeout: timeoutMs / 1000 }, timeoutMs);
}

/** detect(image, object): bounding boxes for every instance of `object`. */
export async function detect(
  image: string,
  object: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<VisionResult<DetectResult>> {
  const resolved = resolveImage(image);
  if (!resolved) return { error: "vision-local: cannot read image" };
  return postJson<DetectResult>("/v1/detect", { image_url: resolved, object, timeout: timeoutMs / 1000 }, timeoutMs);
}

/** point(image, object): pixel coords (one per instance) for `object`. */
export async function point(
  image: string,
  object: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<VisionResult<PointResult>> {
  const resolved = resolveImage(image);
  if (!resolved) return { error: "vision-local: cannot read image" };
  return postJson<PointResult>("/v1/point", { image_url: resolved, object, timeout: timeoutMs / 1000 }, timeoutMs);
}

/**
 * Vision service — bridges to Moondream (caption / query / detect / point).
 *
 * Two transparent backends, picked by env at runtime:
 *
 *   1. **Cloud** (`MOONDREAM_API_KEY` set) — `https://api.moondream.ai/v1`
 *      with `X-Moondream-Auth`. Uses Moondream 3 server-side. ~0.5-1.1s per
 *      call on a normal connection, ~$0.000068 per image (Personal tier
 *      includes $5/mo, ~70k images). Best quality + best latency, but the
 *      image leaves the device and you depend on internet.
 *
 *   2. **Local daemon** — falls back to `http://localhost:2020` (the
 *      `com.jarvis.moondream` launchd service running Moondream Station).
 *      Free, fully offline, but slower (~3-4s per call on M2 Max with
 *      Moondream 2) and quality-limited by what fits in your RAM.
 *
 * The capability name stays `vision-local` upstream because the
 * **interface** is the same — only the endpoint changes. Any caller
 * setting `MOONDREAM_API_KEY` automatically gets the speed/quality
 * upgrade with no code change. Override with `VISION_LOCAL_URL` if you
 * point the daemon somewhere unusual (e.g. a LAN box).
 *
 * If the chosen backend is unreachable every function returns a
 * structured `{ error }` rather than throwing — the caller decides
 * whether to surface "vision unavailable" or fall back further to
 * Claude's own vision via Read tool.
 */
import { readFileSync } from "fs";
import { extname } from "path";
import { logger } from "./logger";

const log = logger.child({ module: "vision-local" });

const CLOUD_URL = "https://api.moondream.ai";
const LOCAL_URL = process.env.VISION_LOCAL_URL || "http://localhost:2020";
const API_KEY = process.env.MOONDREAM_API_KEY;
const USE_CLOUD = !!API_KEY;
const VISION_URL = USE_CLOUD ? CLOUD_URL : LOCAL_URL;
const DEFAULT_TIMEOUT_MS = USE_CLOUD ? 15_000 : 60_000;

if (USE_CLOUD) {
  log.info({ endpoint: CLOUD_URL }, "vision-local using Moondream Cloud (sub-second, M3)");
} else {
  log.info({ endpoint: LOCAL_URL }, "vision-local using local Moondream Station (set MOONDREAM_API_KEY for cloud)");
}

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
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (USE_CLOUD) headers["X-Moondream-Auth"] = API_KEY!;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { error: `vision-local ${path}: HTTP ${res.status}${txt ? ` ${txt.slice(0, 120)}` : ""}` };
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

/**
 * Liveness probe. For Cloud we just check we have a key; we don't burn an
 * API call on every check. For local we hit /health. Returning `false`
 * tells the caller to skip the pre-pass without falling back to a cloud
 * vendor blindly.
 */
export async function isAvailable(timeoutMs = 1500): Promise<boolean> {
  if (USE_CLOUD) return true;
  try {
    const res = await fetch(`${VISION_URL}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Inspect which backend is active — useful for logs/UI. */
export function visionBackend(): "cloud" | "local" {
  return USE_CLOUD ? "cloud" : "local";
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

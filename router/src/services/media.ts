import { execFile } from "child_process";
import { promisify } from "util";
import { readFileSync, mkdirSync, existsSync, unlinkSync, writeFileSync } from "fs";
import { join, basename, extname } from "path";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);
const log = logger.child({ module: "media" });

export const MEDIA_DIR = join(process.env.HOME || "", ".claude/jarvis/media");
if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });

const WHISPER_CLI = "/opt/homebrew/bin/whisper-cli";
const WHISPER_MODEL = join(process.env.HOME || "", "whisper-models/ggml-large-v3.bin");

/**
 * Transcribe audio file using whisper-cli.
 * Converts to WAV first if needed (whisper requires WAV/16kHz).
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  try {
    // Convert to 16kHz WAV for whisper
    const wavPath = filePath.replace(/\.[^.]+$/, "") + ".wav";
    if (filePath !== wavPath) {
      await execFileAsync("ffmpeg", ["-y", "-i", filePath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath], { timeout: 60_000 });
      cleanupMedia(filePath);
    }

    const { stdout } = await execFileAsync(
      WHISPER_CLI, ["-m", WHISPER_MODEL, "-f", wavPath, "--no-timestamps", "-l", "auto"],
      { timeout: 120_000 },
    );

    cleanupMedia(wavPath);

    const text = stdout
      .split("\n")
      .filter((l) => !l.startsWith("whisper_") && !l.startsWith("main:") && l.trim())
      .join(" ")
      .trim();

    return text || "[Audio: no speech detected]";
  } catch (err) {
    log.error({ err, filePath }, "Whisper transcription failed");
    return "[Audio: transcription failed]";
  }
}

/**
 * Prepare image for Claude vision — returns base64 data and mime type.
 * The actual vision analysis happens in Claude itself via content blocks.
 */
export function prepareImageForVision(filePath: string): { base64: string; mimeType: string } | null {
  try {
    const imageBuffer = readFileSync(filePath);
    const base64 = imageBuffer.toString("base64");
    const ext = extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
      ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
      ".gif": "image/gif", ".webp": "image/webp",
    };
    const mimeType = mimeMap[ext] || "image/jpeg";
    return { base64, mimeType };
  } catch (err) {
    log.error({ err, filePath }, "Image preparation failed");
    return null;
  }
}

/**
 * Describe an image — returns placeholder text.
 * Actual vision is handled by passing image as content block to Claude.
 */
export async function describeImage(filePath: string): Promise<string> {
  return "[Image attached — Claude will analyze directly]";
}

/**
 * Extract text from a document.
 */
export async function extractDocumentText(filePath: string, mimeType?: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const name = basename(filePath);

  try {
    if (ext === ".txt" || ext === ".md" || ext === ".csv" || ext === ".json" || ext === ".log") {
      const content = readFileSync(filePath, "utf-8");
      return content.slice(0, 10_000);
    }

    if (ext === ".pdf") {
      try {
        const { stdout } = await execFileAsync("pdftotext", [filePath, "-"], { timeout: 30_000 });
        return stdout.slice(0, 10_000) || `[PDF: no extractable text - ${name}]`;
      } catch {
        return `[PDF document: ${name}]`;
      }
    }

    if (mimeType?.startsWith("text/")) {
      const content = readFileSync(filePath, "utf-8");
      return content.slice(0, 10_000);
    }

    return `[Document: ${name}]`;
  } catch (err) {
    log.error({ err, filePath }, "Document text extraction failed");
    return `[Document: ${name}]`;
  }
}

/**
 * Cleanup a media file after processing.
 */
export function cleanupMedia(filePath: string): void {
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/**
 * Save a buffer to the media directory and return the path.
 */
export function saveMedia(buffer: Buffer, filename: string): string {
  const path = join(MEDIA_DIR, `${Date.now()}-${filename}`);
  writeFileSync(path, buffer);
  return path;
}

/**
 * Download a file from URL to media directory.
 */
export async function downloadMedia(url: string, filename: string): Promise<string> {
  const path = join(MEDIA_DIR, `${Date.now()}-${filename}`);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const buffer = Buffer.from(await resp.arrayBuffer());
  writeFileSync(path, buffer);
  return path;
}


/**
 * Process a media attachment: transcribe/describe/extract based on type.
 */
export async function processMedia(
  type: "voice" | "audio" | "image" | "video" | "document",
  filePath: string,
  mimeType?: string,
): Promise<string> {
  switch (type) {
    case "voice":
    case "audio":
      return transcribeAudio(filePath);
    case "image":
      return describeImage(filePath);
    case "video":
      // Extract audio track and transcribe
      try {
        const audioPath = filePath.replace(/\.[^.]+$/, "") + "-audio.ogg";
        await execFileAsync("ffmpeg", ["-y", "-i", filePath, "-vn", "-acodec", "libopus", audioPath], { timeout: 60_000 });
        cleanupMedia(filePath);
        return transcribeAudio(audioPath);
      } catch {
        cleanupMedia(filePath);
        return "[Video: could not extract audio]";
      }
    case "document":
      const text = await extractDocumentText(filePath, mimeType);
      cleanupMedia(filePath);
      return text;
    default:
      return "[Unknown media type]";
  }
}

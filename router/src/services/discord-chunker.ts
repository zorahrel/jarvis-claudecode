/**
 * Smart Discord message chunker.
 * - Respects 2000 char hard limit
 * - Preserves markdown code fences across chunks
 * - Splits on newlines preferentially
 * - Re-opens fences in continuation chunks
 */

const DISCORD_LIMIT = 1950; // safety margin under 2000

/** Detect if a line opens or closes a code fence */
function isFenceLine(line: string): { open: boolean; lang?: string } | null {
  const match = line.match(/^(`{3,}|~{3,})(\w*)?/);
  if (!match) return null;
  return { open: true, lang: match[2] || undefined };
}

/**
 * Split text into Discord-safe chunks preserving code fences.
 * Each chunk that starts mid-fence gets a re-opened fence prefix,
 * and each chunk that ends mid-fence gets a closing fence suffix.
 */
export function chunkForDiscord(text: string): string[] {
  if (text.length <= DISCORD_LIMIT) return [text];

  const lines = text.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let insideFence = false;
  let fenceLang: string | undefined;
  let fenceMarker = "```"; // track actual marker used

  for (const line of lines) {
    const lineLen = line.length + 1; // +1 for \n

    // Would this line overflow the current chunk?
    // Reserve space for potential closing fence
    const reserve = insideFence ? fenceMarker.length + 1 : 0;

    if (currentLen + lineLen + reserve > DISCORD_LIMIT && current.length > 0) {
      // Flush current chunk
      let chunk = current.join("\n");
      if (insideFence) {
        chunk += "\n" + fenceMarker; // close the fence
      }
      chunks.push(chunk);

      // Start new chunk — re-open fence if we were inside one
      current = [];
      currentLen = 0;
      if (insideFence) {
        const opener = fenceLang ? `${fenceMarker}${fenceLang}` : fenceMarker;
        current.push(opener);
        currentLen = opener.length + 1;
      }
    }

    // Track fence state
    const fence = isFenceLine(line);
    if (fence) {
      if (!insideFence) {
        insideFence = true;
        fenceLang = fence.lang;
        const marker = line.match(/^(`{3,}|~{3,})/);
        if (marker) fenceMarker = marker[1];
      } else {
        // Closing fence
        insideFence = false;
        fenceLang = undefined;
      }
    }

    current.push(line);
    currentLen += lineLen;
  }

  // Flush remaining
  if (current.length > 0) {
    chunks.push(current.join("\n"));
  }

  // Final safety: if any chunk still exceeds limit, hard-split it
  const safe: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= DISCORD_LIMIT + 100) {
      safe.push(chunk);
    } else {
      // Hard split at char boundary as last resort
      let remaining = chunk;
      while (remaining.length > 0) {
        if (remaining.length <= DISCORD_LIMIT) {
          safe.push(remaining);
          break;
        }
        let splitAt = remaining.lastIndexOf("\n", DISCORD_LIMIT);
        if (splitAt <= 0) splitAt = DISCORD_LIMIT;
        safe.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt).replace(/^\n/, "");
      }
    }
  }

  return safe.filter(c => c.length > 0);
}

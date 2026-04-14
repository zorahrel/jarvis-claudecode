import type { Channel } from "../types";

/**
 * Convert Claude's markdown output to platform-native formatting.
 *
 * - Discord: native markdown — pass through unchanged.
 * - Telegram: parse_mode "Markdown" handles standard markdown.
 * - WhatsApp: different syntax — *bold*, _italic_, ~strikethrough~, ```code```.
 *   Claude outputs **bold**, so we convert double→single asterisks, etc.
 */
export function formatForChannel(text: string, channel: Channel | string): string {
  if (channel === "whatsapp") return markdownToWhatsApp(text);
  // Discord and Telegram handle standard markdown natively
  return text;
}

/**
 * Convert standard markdown to WhatsApp-flavored formatting.
 *
 * WhatsApp rules:
 *   *bold*        (single asterisk, NOT double)
 *   _italic_      (single underscore, NOT double)
 *   ~strikethrough~
 *   ```code```    (backticks work the same)
 *   > quote       (works the same)
 *
 * Claude typically outputs:
 *   **bold**      → *bold*
 *   *italic*      → _italic_  (when single asterisk is used for italic)
 *   __italic__    → _italic_
 *   ~~strike~~    → ~strike~
 *   # Heading     → *Heading* (no heading support in WA)
 *   [text](url)   → text (url)
 *   | tables |    → bullet list (WA doesn't support tables)
 */
function markdownToWhatsApp(text: string): string {
  let out = text;

  // Preserve code blocks (don't touch content inside ```)
  const codeBlocks: string[] = [];
  out = out.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Preserve inline code (don't touch content inside `)
  const inlineCode: string[] = [];
  out = out.replace(/`[^`]+`/g, (match) => {
    inlineCode.push(match);
    return `\x00IC${inlineCode.length - 1}\x00`;
  });

  // **bold** → *bold* (double asterisk → single)
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");

  // __italic__ → _italic_ (double underscore → single)
  out = out.replace(/__(.+?)__/g, "_$1_");

  // ~~strikethrough~~ → ~strikethrough~ (double tilde → single)
  out = out.replace(/~~(.+?)~~/g, "~$1~");

  // # Headings → *Bold text* (WA has no headings)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // [text](url) → text (url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

  // Simple markdown tables → bullet lists
  // Detect table rows (lines with | separators), skip separator rows (|---|)
  const lines = out.split("\n");
  const result: string[] = [];
  let inTable = false;
  let headers: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Table separator row
    if (/^\|[\s\-:|]+\|$/.test(trimmed)) {
      inTable = true;
      continue;
    }
    // Table data row
    if (inTable && /^\|/.test(trimmed)) {
      const cells = trimmed.split("|").filter(c => c.trim()).map(c => c.trim());
      if (headers.length && cells.length) {
        const parts = cells.map((c, i) => headers[i] ? `${headers[i]}: ${c}` : c).join(" · ");
        result.push(`• ${parts}`);
      } else {
        result.push(`• ${cells.join(" · ")}`);
      }
      continue;
    }
    // Table header row (first | row before separator)
    if (!inTable && /^\|/.test(trimmed) && trimmed.endsWith("|")) {
      headers = trimmed.split("|").filter(c => c.trim()).map(c => c.trim());
      continue;
    }
    // Not a table row
    if (inTable) { inTable = false; headers = []; }
    result.push(line);
  }
  out = result.join("\n");

  // Restore inline code
  out = out.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCode[parseInt(i)]);
  // Restore code blocks
  out = out.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[parseInt(i)]);

  return out;
}

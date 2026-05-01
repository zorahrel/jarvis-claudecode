/**
 * Strip ONLY the <spoken>...</spoken> delimiters, keep their inner content.
 * Used for the chat log display — il display mostra TUTTO il testo (parlato +
 * non-parlato), ma senza i tag literal che hanno solo significato per la TTS.
 *
 * Differente da extractSpoken (che restituisce SOLO il contenuto dei tag).
 *
 *   in:  "Penso... <spoken>OK fatto.</spoken> Tool output: ..."
 *   out: "Penso... OK fatto. Tool output: ..."
 */
export function stripSpokenTags(text: string): string {
  return text
    .replace(/<spoken>/gi, "")
    .replace(/<\/spoken>/gi, "")
    .replace(/\s{3,}/g, " ")  // collapse extra whitespace from removed tags
    .trim();
}

/**
 * Extract the speakable subset of an LLM response for the notch TTS pipeline.
 *
 * The notch agent is instructed (via `agents/notch/CLAUDE.md`) to wrap the
 * spoken parts of its reply in `<spoken>...</spoken>` tags. Everything outside
 * those tags renders in the chat log but is NOT pronounced — that's where
 * planning, tool output, code blocks, and tables live.
 *
 * Contract (in order of preference):
 *   1. <spoken>...</spoken> tags — preferred path, instructed in agent prompt.
 *      Multiple tags concatenate with a space.
 *   2. Legacy fallback: first paragraph before any code-fence/table, with the
 *      Jarvis footer ([t ...]) and `---` separators stripped. Used when the
 *      agent forgets the contract.
 *   3. Suspicious-content guard: if the legacy fallback looks like raw JSON,
 *      list, or a huge wall of text, return empty rather than torture the
 *      user with a TTS rendering of structured data.
 *
 * Returns "" when nothing is speakable — caller is expected to skip TTS.
 */
export function extractSpoken(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";

  // 1. Preferred: explicit <spoken> tags. Case-insensitive, multi-tag concat.
  //    The non-greedy `[\s\S]*?` is critical — `<spoken>...</spoken>` is the
  //    smallest possible match so adjacent tags don't collapse into one.
  const spokenMatches = [...trimmed.matchAll(/<spoken>([\s\S]*?)<\/spoken>/gi)];
  if (spokenMatches.length > 0) {
    const joined = spokenMatches
      .map((m) => m[1].trim())
      .filter(Boolean)
      .join(" ");
    return joined;
  }

  // 2. Legacy fallback: first paragraph before code/table, with footer strip.
  //    This preserves backward-compat with the original notch.ts:113-118 regex
  //    so a transitional period where the agent occasionally forgets the
  //    contract degrades gracefully instead of going silent.
  const beforeCode = trimmed.split(/\n```|\n\|/)[0];
  const beforeFooter = beforeCode
    .replace(/\n+\[t [^\]]+\][\s\S]*$/m, "")
    .replace(/\n+---+\n[\s\S]*$/, "")
    .trim();

  // 3. Suspicious-content guard. If we got here without <spoken> tags AND the
  //    fallback content looks structured rather than prose, skip TTS — better
  //    silent than reading aloud a JSON dump.
  if (!beforeFooter) return "";
  if (beforeFooter.length > 600) return ""; // long replies without tags = probably structured
  if (beforeFooter.startsWith("{") || beforeFooter.startsWith("[")) return ""; // JSON / list

  return beforeFooter;
}

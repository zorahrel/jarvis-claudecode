/**
 * Run with: npx tsx --test src/services/spoken-extractor.test.ts
 *
 * Uses node:test built-in (no jest/vitest dependency). The notch TTS pipeline
 * cannot regress — silent TTS is debuggable, but reading aloud raw JSON or
 * planning text annoys the user every single turn.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractSpoken } from "./spoken-extractor.js";

test("preferred path: single <spoken> tag", () => {
  const input =
    "Penso... devo controllare. <spoken>OK fatto, tutto ok.</spoken> Tool output: {...}";
  assert.equal(extractSpoken(input), "OK fatto, tutto ok.");
});

test("multiple <spoken> tags concat with space", () => {
  const input =
    "<spoken>Primo passaggio.</spoken>\n```bash\nls\n```\n<spoken>Secondo passaggio.</spoken>";
  assert.equal(extractSpoken(input), "Primo passaggio. Secondo passaggio.");
});

test("case-insensitive tag match", () => {
  assert.equal(extractSpoken("<SPOKEN>ciao</SPOKEN>"), "ciao");
  assert.equal(extractSpoken("<Spoken>ciao</Spoken>"), "ciao");
});

test("empty <spoken> tag returns empty (filtered)", () => {
  assert.equal(extractSpoken("<spoken></spoken>"), "");
  assert.equal(extractSpoken("<spoken>   </spoken>"), "");
});

test("legacy fallback: first paragraph before code-fence", () => {
  const input = "Ciao Attilio, eccoti.\n\n```bash\nls\n```";
  assert.equal(extractSpoken(input), "Ciao Attilio, eccoti.");
});

test("legacy fallback: first paragraph before markdown table", () => {
  const input = "Riepilogo:\n\n| col1 | col2 |\n|---|---|\n| a | b |";
  assert.equal(extractSpoken(input), "Riepilogo:");
});

test("legacy fallback: strips Jarvis [t ...] footer", () => {
  const input = "Tutto ok.\n\n[t llm=2.1s wall=2.4s]";
  assert.equal(extractSpoken(input), "Tutto ok.");
});

test("legacy fallback: strips --- separator + after", () => {
  const input = "Risposta breve.\n\n---\nDettagli tecnici qui.";
  assert.equal(extractSpoken(input), "Risposta breve.");
});

test("suspicious-content guard: empty on raw JSON object", () => {
  assert.equal(extractSpoken('{"key": "value"}'), "");
});

test("suspicious-content guard: empty on raw JSON array", () => {
  assert.equal(extractSpoken('[1, 2, 3]'), "");
});

test("suspicious-content guard: empty on long unstructured response", () => {
  // Deliberately > 600 chars without <spoken> tags → structured noise
  const long = "a".repeat(700);
  assert.equal(extractSpoken(long), "");
});

test("empty input returns empty", () => {
  assert.equal(extractSpoken(""), "");
  assert.equal(extractSpoken("   \n\n   "), "");
});

test("real-world: planning + tool call + spoken summary", () => {
  const input = `Devo controllare lo status del router.

\`\`\`bash
launchctl list | grep jarvis
\`\`\`

<spoken>Il router gira da tre giorni con due e tre giga di RAM. Tutto ok.</spoken>

[t llm=1.4s wall=1.7s]`;
  assert.equal(
    extractSpoken(input),
    "Il router gira da tre giorni con due e tre giga di RAM. Tutto ok.",
  );
});

test("real-world: agent forgets <spoken>, legacy fallback kicks in", () => {
  const input = `Tutto fatto, ho deployato la fix.

\`\`\`
git push origin main
\`\`\`

[t llm=2.0s]`;
  assert.equal(extractSpoken(input), "Tutto fatto, ho deployato la fix.");
});

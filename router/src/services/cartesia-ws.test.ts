/**
 * Run with: npx tsx --test src/services/cartesia-ws.test.ts
 *
 * Unit tests for the streaming-text primitives. The Cartesia WS network
 * path is not tested here (would require live API + audio diff) — only the
 * pure functions that decide WHAT goes to Cartesia.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { SpokenTagStreamParser, SentenceBoundaryBuffer } from "./cartesia-ws.js";

// ---------------------------------------------------------------------------
// SpokenTagStreamParser
// ---------------------------------------------------------------------------

test("parser: simple single tag in one feed", () => {
  const p = new SpokenTagStreamParser();
  assert.equal(p.feed("Penso. <spoken>OK fatto.</spoken> Output: ..."), "OK fatto.");
});

test("parser: drops everything outside tags", () => {
  const p = new SpokenTagStreamParser();
  assert.equal(p.feed("This is plain text"), "");
});

test("parser: tag split across two feeds", () => {
  const p = new SpokenTagStreamParser();
  // First chunk has incomplete opening tag
  assert.equal(p.feed("Penso. <spo"), "");
  // Second chunk completes opening tag and has content
  assert.equal(p.feed("ken>Tutto"), "Tutto");
  // Third chunk has incomplete closing tag
  assert.equal(p.feed(" bene.</spo"), " bene.");
  // Fourth chunk completes closing tag
  assert.equal(p.feed("ken> later"), "");
});

test("parser: tag boundary char-by-char", () => {
  const p = new SpokenTagStreamParser();
  let out = "";
  for (const ch of "X<spoken>AB</spoken>Y") out += p.feed(ch);
  assert.equal(out, "AB");
});

test("parser: case-insensitive open and close", () => {
  const p = new SpokenTagStreamParser();
  assert.equal(p.feed("<SPOKEN>OK</SPOKEN>"), "OK");
  const p2 = new SpokenTagStreamParser();
  assert.equal(p2.feed("<Spoken>ok</Spoken>"), "ok");
});

test("parser: stray '<' inside tag is emitted verbatim", () => {
  const p = new SpokenTagStreamParser();
  // '<em>' inside spoken: not a closing tag → should appear in output
  assert.equal(p.feed("<spoken>ciao <em>amico</em></spoken>"), "ciao <em>amico</em>");
});

test("parser: mismatched open '<thinking' is dropped", () => {
  const p = new SpokenTagStreamParser();
  assert.equal(p.feed("<thinking>oh</thinking><spoken>OK</spoken>"), "OK");
});

test("parser: multiple tags concatenate", () => {
  const p = new SpokenTagStreamParser();
  assert.equal(
    p.feed("<spoken>Primo.</spoken>\n```\ncode\n```\n<spoken>Secondo.</spoken>"),
    "Primo.Secondo.",
  );
});

test("parser: incomplete tag at end of stream is silently dropped on flush", () => {
  const p = new SpokenTagStreamParser();
  assert.equal(p.feed("<spoken>OK"), "OK");
  // simulate LLM stop mid-tag
  p.flush();
  // Next feed should start fresh OUTSIDE state
  assert.equal(p.feed("<spoken>X</spoken>"), "X");
});

// ---------------------------------------------------------------------------
// SentenceBoundaryBuffer
// ---------------------------------------------------------------------------

test("buffer: flushes on period", () => {
  const b = new SentenceBoundaryBuffer();
  assert.deepEqual(b.feed("Ciao a tutti."), ["Ciao a tutti."]);
});

test("buffer: holds incomplete sentence", () => {
  const b = new SentenceBoundaryBuffer();
  assert.deepEqual(b.feed("Sto scrivendo"), []);
  assert.deepEqual(b.feed(" qualcosa."), ["Sto scrivendo qualcosa."]);
});

test("buffer: multiple sentences in one feed", () => {
  const b = new SentenceBoundaryBuffer();
  // "Terza." is short (<12 chars) and trailing — stays buffered for the next
  // feed (or flushed at LLM end). Only the two long sentences ship out now.
  assert.deepEqual(
    b.feed("Prima frase lunga abbastanza. Seconda anche lunga. Terza."),
    ["Prima frase lunga abbastanza.", "Seconda anche lunga."],
  );
  assert.equal(b.flush(), "Terza.");
});

test("buffer: short sentence combines with next", () => {
  const b = new SentenceBoundaryBuffer();
  // "OK." is below MIN_FLUSH_LEN (12) → wait for next boundary
  assert.deepEqual(b.feed("OK. Ho fatto il deploy."), ["OK. Ho fatto il deploy."]);
});

test("buffer: short sentence at end stays buffered", () => {
  const b = new SentenceBoundaryBuffer();
  // No second boundary after "OK." → keep buffering
  assert.deepEqual(b.feed("OK."), []);
  // flush() pulls the tail
  assert.equal(b.flush(), "OK.");
});

test("buffer: handles ! ? \\n boundaries", () => {
  const b = new SentenceBoundaryBuffer();
  assert.deepEqual(b.feed("Davvero buono!"), ["Davvero buono!"]);
  assert.deepEqual(b.feed("Sicuro che funziona?"), ["Sicuro che funziona?"]);
  assert.deepEqual(b.feed("Frase con newline lunga\nseconda riga lunga\n"), [
    "Frase con newline lunga",
    "seconda riga lunga",
  ]);
});

test("buffer: multi-feed token-by-token", () => {
  const b = new SentenceBoundaryBuffer();
  const out: string[] = [];
  for (const tok of ["Ho", " fatto", " il", " deploy", " del", " fix", "."]) {
    out.push(...b.feed(tok));
  }
  assert.deepEqual(out, ["Ho fatto il deploy del fix."]);
});

test("buffer: flush returns trimmed tail", () => {
  const b = new SentenceBoundaryBuffer();
  b.feed("Sto pensando");
  assert.equal(b.flush(), "Sto pensando");
  // Subsequent flush returns empty (buffer already drained)
  assert.equal(b.flush(), "");
});

// ---------------------------------------------------------------------------
// Integration: parser + buffer together (the real pipeline)
// ---------------------------------------------------------------------------

test("integration: LLM-like token stream with mixed thinking + spoken", () => {
  const parser = new SpokenTagStreamParser();
  const buffer = new SentenceBoundaryBuffer();
  const flushed: string[] = [];

  // Simulate Claude streaming tokens — some outside, some inside <spoken>
  const tokens = [
    "Penso", " di",
    " controllare.",
    " <spoken>", "Tutto", " bene", ",",
    " router", " ok", ".", "</spoken>",
    " Tool", " output:", " {...}",
    " <spoken>", "Dimmi", " cosa", " serve", ".", "</spoken>",
  ];

  for (const tok of tokens) {
    const speakable = parser.feed(tok);
    flushed.push(...buffer.feed(speakable));
  }
  // End of LLM
  const tail = buffer.flush();
  if (tail) flushed.push(tail);

  assert.deepEqual(flushed, ["Tutto bene, router ok.", "Dimmi cosa serve."]);
});

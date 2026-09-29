/**
 * Run with: npx tsx --test src/services/redact-secrets.test.ts
 *
 * Il caso vero: grammy logga HttpError con dentro un FetchError il cui message
 * e stack contengono https://api.telegram.org/bot<id>:<secret>/setMyCommands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, redactString } from "./redact-secrets.js";

const SECRET = "AAH_fake-Secret_0123456789abcdefghijk";
const URL = `https://api.telegram.org/bot1234567890:${SECRET}/setMyCommands`;

class HttpError extends Error {
  constructor(message: string, public error: unknown) {
    super(message);
    this.name = "HttpError";
  }
}

test("redactString keeps the bot id and hides the secret", () => {
  assert.equal(
    redactString(`request to ${URL} failed`),
    "request to https://api.telegram.org/bot1234567890:***/setMyCommands failed",
  );
});

test("nested Error message and stack are redacted, type is kept", () => {
  const inner = new Error(`request to ${URL} failed, reason: getaddrinfo ENOTFOUND`);
  const outer = new HttpError("Network request for 'setMyCommands' failed!", inner);
  const logged = redactSecrets({ err: outer, menuSize: 38 });

  const dump = JSON.stringify(logged, (_k, v) =>
    v instanceof Error ? { ...v, name: v.name, message: v.message, stack: v.stack } : v,
  );
  assert.ok(!dump.includes(SECRET), "secret leaked into the serialized log object");
  assert.ok(dump.includes("bot1234567890:***"));
  assert.equal(logged.err instanceof HttpError, true);
  assert.equal(logged.menuSize, 38);
  // L'originale non viene toccato: il chiamante può ancora usarlo.
  assert.ok(inner.message.includes(SECRET));
});

test("cycles and non-plain objects survive", () => {
  const a: Record<string, unknown> = { url: URL };
  a.self = a;
  const buf = Buffer.from("x");
  const out = redactSecrets({ a, buf, when: new Date(0) }) as { a: Record<string, unknown>; buf: Buffer; when: Date };
  assert.equal(out.a.url, "https://api.telegram.org/bot1234567890:***/setMyCommands");
  assert.equal(out.a.self, out.a);
  assert.equal(out.buf, buf);
  assert.equal(out.when.getTime(), 0);
});

/**
 * Run with: npx tsx --test src/services/identity.test.ts
 *
 * Pure resolver tests — no live config needed (resolveUserFrom takes the users
 * map directly). Guards the dead-config-revived `users:` → role mapping that
 * powers "who wrote this and what's their relationship to me".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveUserFrom } from "./identity.js";
import type { User } from "../types";

const USERS: Record<string, User> = {
  attilio: { type: "owner", ids: { telegram: 100000001, discord: "200000000000000001", whatsapp: "+390000000101" } },
  matteo: { type: "team", ids: { whatsapp: "+390000000102" } },
  simone: { type: "client", ids: { whatsapp: "120000000000000000@g.us" } },
};

test("resolves owner across channels (number + string ids)", () => {
  const tg = resolveUserFrom(USERS, "telegram", "100000001");
  assert.deepEqual(tg, { key: "attilio", name: "Attilio", role: "owner" });

  const dc = resolveUserFrom(USERS, "discord", "200000000000000001");
  assert.equal(dc?.role, "owner");
  assert.equal(dc?.name, "Attilio");

  const wa = resolveUserFrom(USERS, "whatsapp", "+390000000101");
  assert.equal(wa?.role, "owner");
});

test("resolves team and client roles", () => {
  assert.equal(resolveUserFrom(USERS, "whatsapp", "+390000000102")?.role, "team");
  assert.equal(resolveUserFrom(USERS, "whatsapp", "+390000000102")?.name, "Matteo");
  // A whole group jid can map to a client (resolveChat path).
  assert.equal(resolveUserFrom(USERS, "whatsapp", "120000000000000000@g.us")?.role, "client");
});

test("unknown sender → null", () => {
  assert.equal(resolveUserFrom(USERS, "telegram", "999999"), null);
  assert.equal(resolveUserFrom(USERS, "whatsapp", "+390000000000"), null);
});

test("right id, wrong channel → null (no cross-channel id bleed)", () => {
  // Attilio's telegram numeric id must not match on discord.
  assert.equal(resolveUserFrom(USERS, "discord", "100000001"), null);
  // Matteo has no telegram id.
  assert.equal(resolveUserFrom(USERS, "telegram", "+390000000102"), null);
});

test("nullish id → null", () => {
  assert.equal(resolveUserFrom(USERS, "telegram", undefined), null);
  assert.equal(resolveUserFrom(USERS, "telegram", ""), null);
});

test("empty users map → null (graceful when config absent)", () => {
  assert.equal(resolveUserFrom({}, "telegram", "100000001"), null);
});

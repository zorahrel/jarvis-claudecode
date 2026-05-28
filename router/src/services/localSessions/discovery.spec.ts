import { test } from "node:test";
import assert from "node:assert/strict";
import { redactCommand } from "./discovery.js";

test("redactCommand: scrubs token/secret values inside inline --mcp-config JSON", () => {
  const cmd =
    'claude --mcp-config {"mcpServers":{"hetzner":{"env":{"HETZNER_API_TOKEN":"FAKE_token_value_aaaa","HCLOUD_TOKEN":"FAKE_hcloud_bbbb"}}}} --model opus';
  const out = redactCommand(cmd);
  assert.ok(!out.includes("FAKE_token_value_aaaa"), "API token value must not survive");
  assert.ok(!out.includes("FAKE_hcloud_bbbb"), "HCLOUD token value must not survive");
  assert.match(out, /"HETZNER_API_TOKEN":"<redacted>"/);
  assert.match(out, /"HCLOUD_TOKEN":"<redacted>"/);
});

test("redactCommand: scrubs KEY/SECRET/PASSWORD JSON values", () => {
  const cmd =
    '{"env":{"SUPABASE_SERVICE_KEY":"sk_live_abc","DB_PASSWORD":"hunter2","MY_SECRET":"shh"}}';
  const out = redactCommand(cmd);
  for (const leaked of ["sk_live_abc", "hunter2", "shh"]) {
    assert.ok(!out.includes(leaked), `${leaked} must be redacted`);
  }
});

test("redactCommand: scrubs env-assignment form KEY=value", () => {
  const out = redactCommand("HCLOUD_TOKEN=secret123 --effort medium");
  assert.equal(out, "HCLOUD_TOKEN=<redacted> --effort medium");
});

test("redactCommand: leaves non-sensitive fields intact", () => {
  const cmd =
    'claude --model opus --mcp-config {"mcpServers":{"exa":{"type":"http","url":"https://mcp.exa.ai/mcp?tools=web_search_exa"}}} --effort medium';
  assert.equal(redactCommand(cmd), cmd, "no sensitive keys → unchanged");
});

/**
 * SDK stream mock for Context Inspector unit tests.
 * Place outside src/ so it is never accidentally bundled with production code.
 * Usage: import { mockSdkStream, mockTypicalTurn } from "../../scripts/sdk-mock.js"
 */

// Type: minimal subset of SDKMessage shapes used by downstream code.
export type MockSdkEvent =
  | { type: "system"; subtype: "task_progress"; usage: { total_tokens: number; input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }; model?: string }
  | { type: "assistant"; message: { content: Array<{ type: "text"; text: string } | { type: "tool_use"; name: string; input: Record<string, unknown>; id: string }>; model?: string } }
  | { type: "result"; subtype: "success" | "error_during_execution" | "error_max_turns"; usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }; total_cost_usd?: number; result?: string; duration_ms?: number; duration_api_ms?: number };

export async function* mockSdkStream(events: MockSdkEvent[]): AsyncGenerator<MockSdkEvent> {
  for (const ev of events) {
    // simulate async — microtask delay so consumers see real iteration semantics
    await new Promise(r => setImmediate(r));
    yield ev;
  }
}

// Convenience helper: typical 1-turn sequence (3 task_progress updates → 1 assistant text → 1 result)
export function mockTypicalTurn(opts: { progressTokens: number[]; finalCost: number; finalUsage: { input: number; output: number; cacheCreation: number; cacheRead: number } }): MockSdkEvent[] {
  const events: MockSdkEvent[] = [];
  for (const t of opts.progressTokens) {
    events.push({ type: "system", subtype: "task_progress", usage: { total_tokens: t } });
  }
  events.push({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } });
  events.push({
    type: "result",
    subtype: "success",
    total_cost_usd: opts.finalCost,
    usage: {
      input_tokens: opts.finalUsage.input,
      output_tokens: opts.finalUsage.output,
      cache_creation_input_tokens: opts.finalUsage.cacheCreation,
      cache_read_input_tokens: opts.finalUsage.cacheRead,
    },
    result: "ok",
    duration_ms: 1000,
    duration_api_ms: 800,
  });
  return events;
}

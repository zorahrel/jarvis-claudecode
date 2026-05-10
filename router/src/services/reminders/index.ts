/**
 * Reminders bridge — public barrel (Phase 2 Plan 02-02).
 *
 * Single import path for the dashboard handler, the polling boot wiring,
 * and the snapshot enricher (todo_link join via parsed pid).
 */

export { listTodos, addTodo, completeTodo, probeAuth, getActiveCli } from "./cli.js";
export { parseTodoMetadata, formatTodoMetadata } from "./metadata.js";
export { startReminderPolling, stopReminderPolling, diffTodos } from "./poll.js";
export type { ReminderTodo, RemindersCli, CliProbe, TodoEvent, TodoMetadata, TodoPhase } from "./types.js";

export { ensureHooksInstalled, uninstallHooks, EVENTS_DIR } from "./hooksInstaller";
export { discoverLocalSessions, invalidateLocalSessionsCache } from "./discovery";
export { dispatchOpenTarget, availableTargets } from "./openTargets";
export type { LocalSession, LocalSessionStatus, OpenTargetId, TargetAvailability } from "./types";

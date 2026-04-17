export type LocalSessionStatus = "working" | "idle" | "waiting" | "finished" | "errored" | "unknown";

export interface LocalSession {
  pid: number;
  cwd: string;
  repoName: string;
  branch: string | null;
  status: LocalSessionStatus;
  hookEvent: string | null;
  sessionId: string | null;
  transcriptPath: string | null;
  lastActivity: number;
  tty: string | null;
  parentCommand: string | null;
  preview: {
    lastUserMessage: string | null;
    lastAssistantText: string | null;
  };
  isRouterSpawned: boolean;
}

export type OpenTargetId = "iterm" | "terminal" | "topics" | "finder" | "editor" | "pr";

export interface TargetAvailability {
  id: OpenTargetId;
  available: boolean;
  label: string;
  reason?: string;
}

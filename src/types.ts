export type WorkItemStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface WorkItemAttachment {
  id: string;
  filename?: string;
  contentType?: string;
  size?: number;
  path?: string;
}

export interface WorkItemSource {
  transport: "signal";
  sender: string;
  conversation: string;
  messageId: string;
  timestamp: number;
}

export interface WorkItem {
  id: string;
  mode?: "task" | "question";
  instruction: string;
  attachments: WorkItemAttachment[];
  source: WorkItemSource;
  createdAt: string;
}

export interface WorkItemResult {
  summary: string;
  artifactPaths?: string[];
  commit?: string;
  filesChanged?: number;
  threadId?: string;
}

export interface WorkItemRecord {
  item: WorkItem;
  status: WorkItemStatus;
  updatedAt: string;
  error?: string;
  result?: WorkItemResult;
}

export interface WorkspaceConfig {
  path: string;
  allowWrite: boolean;
  validateCommand: string[];
  shipCommands: string[][];
}

export interface IntakeConfig {
  signal: {
    account: string;
    groupId: string;
    groupName: string;
    allowedSenders: string[];
    executable: string;
    dataDirectory?: string;
  };
  codex: {
    executable: string;
    extraArgs: string[];
    model: string;
    reasoningEffort: string;
  };
  entire: {
    executable: string;
  };
  stateDirectory: string;
  workspace: WorkspaceConfig;
  mcp: { host: string; port: number };
}

export interface IncomingSignalMessage {
  sender: string;
  groupId: string;
  timestamp: number;
  message: string;
  attachments: WorkItemAttachment[];
}

export type IntakeCommand =
  | { kind: "codex"; instruction: string }
  | { kind: "ask"; question: string }
  | { kind: "status"; id?: string }
  | { kind: "cancel"; id?: string }
  | { kind: "ship" }
  | { kind: "feature"; request: string }
  | {
    kind: "capture";
    action: "start" | "status" | "done" | "cancel";
    title?: string;
  }
  | { kind: "dispatch"; args: string[] }
  | { kind: "context" }
  | { kind: "model"; alias?: string }
  | { kind: "help" }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: string };

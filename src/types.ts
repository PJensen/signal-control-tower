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
  project: string;
  instruction: string;
  branch?: string;
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

export interface WorkItemPublication {
  remote: string;
  branch: string;
  commit: string;
  publishedAt: string;
}

export interface WorkItemDeployment {
  commit: string;
  deployedAt: string;
}

export interface WorkItemRecord {
  item: WorkItem;
  status: WorkItemStatus;
  updatedAt: string;
  error?: string;
  result?: WorkItemResult;
  publication?: WorkItemPublication;
  deployment?: WorkItemDeployment;
}

export interface ProjectConfig {
  path: string;
  allowWrite: boolean;
  baseRef: string;
  isolatedWorktree: boolean;
  release?: {
    publishRemote: string;
    validateCommand: string[];
    deployCommand?: string[];
  };
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
  };
  activity: {
    executable: string;
  };
  stateDirectory: string;
  projects: Record<string, ProjectConfig>;
}

export interface IncomingSignalMessage {
  sender: string;
  groupId: string;
  timestamp: number;
  message: string;
  attachments: WorkItemAttachment[];
}

export type IntakeCommand =
  | { kind: "codex"; project?: string; instruction: string }
  | { kind: "ask"; project?: string; question: string }
  | { kind: "status"; id?: string }
  | { kind: "cancel"; id?: string }
  | { kind: "publish"; id: string }
  | { kind: "deploy"; id: string }
  | { kind: "feature"; request: string }
  | { kind: "activity"; args: string[] }
  | { kind: "context"; project?: string }
  | { kind: "help" }
  | { kind: "ignore" }
  | { kind: "invalid"; reason: string };

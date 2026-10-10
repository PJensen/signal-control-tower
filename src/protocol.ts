import type { IncomingSignalMessage, IntakeCommand, WorkItemAttachment } from "./types.ts";

const MAX_INSTRUCTION_LENGTH = 20_000;

function commandWords(value: string): string[] | undefined {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote === '"' && index + 1 < value.length) {
        word += value[++index] ?? "";
      } else word += character;
      started = true;
    } else if (character === "'" || character === '"') {
      quote = character;
      started = true;
    } else if (character === "\\" && index + 1 < value.length) {
      word += value[++index] ?? "";
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (quote) return undefined;
  if (started) words.push(word);
  return words;
}

function dispatchArguments(value: string): string[] | string {
  const words = commandWords(value);
  if (!words) return "The /dispatch arguments contain an unmatched quote.";
  const args: string[] = [];
  let local = false;
  let repos = false;
  let agent = false;
  let allBranches = false;
  let voice = false;
  for (let index = 0; index < words.length; index += 1) {
    const flag = words[index] ?? "";
    if (flag === "--local") local = true;
    else if (flag === "--all-branches") allBranches = true;
    else if (flag === "-h" || flag === "--help") return ["--help"];
    else if (["--agent", "--repos", "--since", "--until", "--voice"].includes(flag)) {
      const argument = words[++index];
      if (!argument) return `${flag} requires a value.`;
      if (flag === "--repos") repos = true;
      if (flag === "--agent") agent = true;
      if (flag === "--voice") voice = true;
      args.push(flag, argument);
      continue;
    } else return `Unsupported /dispatch flag: ${flag}`;
    args.push(flag);
  }
  if (repos && local) return "--repos cannot be combined with --local.";
  if (repos && (agent || allBranches)) {
    return "--agent and --all-branches require local dispatch generation.";
  }
  if (!repos && !local) args.push("--local");
  if (!voice) args.push("--voice", "neutral");
  return args;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeAttachments(value: unknown): WorkItemAttachment[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((entry, index) => {
    const attachment = object(entry);
    if (!attachment) return [];
    const id = string(attachment.id) ?? string(attachment.uuid) ?? `attachment-${index + 1}`;
    const normalized: WorkItemAttachment = { id };
    const filename = string(attachment.filename);
    const contentType = string(attachment.contentType);
    const size = number(attachment.size);
    const path = string(attachment.path) ?? string(attachment.localPath) ??
      string(attachment.storedFilename);
    if (filename) normalized.filename = filename;
    if (contentType) normalized.contentType = contentType;
    if (size !== undefined) normalized.size = size;
    if (path) normalized.path = path;
    return [normalized];
  });
}

function groupIdFrom(message: Record<string, unknown>): string | undefined {
  const groupInfo = object(message.groupInfo);
  const groupV2 = object(message.groupV2);
  return (
    string(groupInfo?.groupId) ??
      string(groupInfo?.id) ??
      string(groupV2?.groupId) ??
      string(groupV2?.id)
  );
}

export function signalNotificationToMessage(value: unknown): IncomingSignalMessage | undefined {
  const notification = object(value);
  if (notification?.method !== "receive") return undefined;

  const params = object(notification.params);
  const result = object(params?.result);
  const envelope = object(result?.envelope) ?? object(params?.envelope);
  if (!envelope) return undefined;

  const directMessage = object(envelope.dataMessage);
  const sentMessage = object(object(envelope.syncMessage)?.sentMessage);
  const message = directMessage ?? sentMessage;
  if (!message) return undefined;

  const text = string(message.message);
  const groupId = groupIdFrom(message);
  const account = string(result?.account) ?? string(params?.account);
  const sender = sentMessage
    ? account ?? string(envelope.sourceNumber) ?? string(envelope.sourceUuid)
    : string(envelope.sourceNumber) ?? string(envelope.sourceUuid) ?? string(envelope.source);
  const timestamp = number(message.timestamp) ?? number(envelope.timestamp);

  if (!text || !groupId || !sender || timestamp === undefined) return undefined;

  return {
    sender,
    groupId,
    timestamp,
    message: text,
    attachments: normalizeAttachments(message.attachments),
  };
}

export function parseIntakeCommand(raw: string): IntakeCommand {
  const text = raw.trim();
  if (!text.startsWith("/")) return { kind: "ignore" };

  const newline = text.indexOf("\n");
  const firstLine = (newline === -1 ? text : text.slice(0, newline)).trim();
  const body = newline === -1 ? "" : text.slice(newline + 1).trim();
  const [command, ...args] = firstLine.split(/\s+/u);

  switch (command?.toLowerCase()) {
    case "/codex": {
      if (!body) {
        const instruction = args.join(" ").trim();
        if (!instruction) return { kind: "invalid", reason: "The Codex instruction is empty." };
        if (instruction.length > MAX_INSTRUCTION_LENGTH) {
          return {
            kind: "invalid",
            reason: `The instruction exceeds ${MAX_INSTRUCTION_LENGTH} characters.`,
          };
        }
        return { kind: "codex", instruction };
      }
      if (args.length > 0) {
        return {
          kind: "invalid",
          reason: "Use /codex followed by the instruction on a new line.",
        };
      }
      if (body.length > MAX_INSTRUCTION_LENGTH) {
        return {
          kind: "invalid",
          reason: `The instruction exceeds ${MAX_INSTRUCTION_LENGTH} characters.`,
        };
      }
      return { kind: "codex", instruction: body };
    }
    case "/ask": {
      const question = [args.join(" ").trim(), body].filter(Boolean).join("\n");
      if (!question) return { kind: "invalid", reason: "The codebase question is empty." };
      if (question.length > MAX_INSTRUCTION_LENGTH) {
        return {
          kind: "invalid",
          reason: `The question exceeds ${MAX_INSTRUCTION_LENGTH} characters.`,
        };
      }
      return { kind: "ask", question };
    }
    case "/status":
      return args.length <= 1
        ? { kind: "status", ...(args[0] ? { id: args[0] } : {}) }
        : { kind: "invalid", reason: "Use /status or /status <work-item-id>." };
    case "/cancel":
      return args.length <= 1
        ? { kind: "cancel", ...(args[0] ? { id: args[0] } : {}) }
        : { kind: "invalid", reason: "Use /cancel or /cancel <work-item-id>." };
    case "/ship":
      return args.length === 0
        ? { kind: "ship" }
        : { kind: "invalid", reason: "Use /ship without arguments." };
    case "/feature": {
      const request = [args.join(" ").trim(), body].filter(Boolean).join("\n");
      if (!request) return { kind: "invalid", reason: "The feature request is empty." };
      if (request.length > MAX_INSTRUCTION_LENGTH) {
        return {
          kind: "invalid",
          reason: `The feature request exceeds ${MAX_INSTRUCTION_LENGTH} characters.`,
        };
      }
      return { kind: "feature", request };
    }
    case "/capture": {
      if (body) {
        return { kind: "invalid", reason: "Use /capture commands on one line." };
      }
      const action = args.shift()?.toLowerCase();
      if (action === "start") {
        const title = args.join(" ").trim();
        return {
          kind: "capture",
          action: "start",
          ...(title ? { title } : {}),
        };
      }
      if (["status", "done", "cancel"].includes(action ?? "") && args.length === 0) {
        return { kind: "capture", action: action as "status" | "done" | "cancel" };
      }
      return {
        kind: "invalid",
        reason: "Use /capture start [title], /capture status, /capture done, or /capture cancel.",
      };
    }
    case "/dispatch": {
      if (body) return { kind: "invalid", reason: "Use /dispatch and its flags on one line." };
      const parsed = dispatchArguments(firstLine.slice(command.length).trim());
      return typeof parsed === "string"
        ? { kind: "invalid", reason: parsed }
        : { kind: "dispatch", args: parsed };
    }
    case "/context":
      return args.length === 0
        ? { kind: "context" }
        : { kind: "invalid", reason: "Use /context without arguments." };
    case "/model":
      return args.length <= 1 && !body
        ? { kind: "model", ...(args[0] ? { alias: args[0].toLowerCase() } : {}) }
        : { kind: "invalid", reason: "Use /model [alias] on one line." };
    case "/help":
      return args.length === 0
        ? { kind: "help" }
        : { kind: "invalid", reason: "Use /help without arguments." };
    default:
      return {
        kind: "invalid",
        reason: "Unknown intake command. Send /help for the supported protocol.",
      };
  }
}

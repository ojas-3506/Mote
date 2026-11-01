import type { EvtFrame, GitStatusKind, PermissionUpdate } from '@mote/protocol';

/**
 * The session model: the event stream, folded into something a screen can
 * draw.
 *
 * The event log is the source of truth — it is append-only, ordered by
 * `seq`, and replayable. This module is the only thing that interprets it.
 *
 * Two properties make that worth doing carefully:
 *
 * 1. **A reconnect reproduces the same view.** The client asks for the gap
 *    after its cursor and the host replays it, so the fold has to be
 *    deterministic per `seq`. Nothing here may depend on wall-clock time or
 *    on what the client happened to be looking at.
 *
 * 2. **The host sends the same text twice.** `assistant.delta` streams the
 *    text in, and then `assistant.message` sends it again, complete. The
 *    deltas are the *preview*; the final messages are the *truth*. Showing
 *    both is how you get every reply printed twice.
 */

/** A block of text in the transcript. */
export interface Turn {
  /** The SDK's message id. */
  id: string;
  kind: 'user' | 'assistant' | 'thinking';
  /** The finished text, from the final `assistant.message` events. */
  text: string;
  /** The text as it streamed in. Shown until the turn is finished. */
  preview: string;
  /** True while the turn is still in flight. */
  streaming: boolean;
  /** The sequence number of the first event for this turn. */
  seq: number;
  attachments?: { mimeType: string; name: string; size: number }[];
}

/** A tool call and, once it has run, its result. */
export interface ToolCall {
  toolUseId: string;
  name: string;
  displayName: string;
  input: Record<string, unknown>;
  output?: string;
  ok?: boolean;
  durationMs?: number;
  seq: number;
}

/** A permission request waiting for an answer. */
export interface PendingPermission {
  requestId: string;
  toolUseId: string;
  toolName: string;
  displayName: string;
  title: string;
  description: string;
  input: Record<string, unknown>;
  defaultToNo: boolean;
  blockedPath?: string;
  decisionReason?: string;
  agentID?: string;
  suggestions: PermissionUpdate[];
  mcpServer?: { name: string; source: string };
}

/** The working tree, as the host sees it. */
export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  changes: { path: string; status: GitStatusKind }[];
}

export interface SessionModel {
  turns: Map<string, Turn>;
  tools: Map<string, ToolCall>;
  pending?: PendingPermission;
  git?: GitStatus;
  /** The last error the host reported about the session. */
  error?: string;
  /** True between a prompt and the end of the turn. */
  working: boolean;
  /** The highest sequence number folded in so far. */
  lastSeq: number;
}

export function emptyModel(): SessionModel {
  return {
    turns: new Map(),
    tools: new Map(),
    pending: undefined,
    git: undefined,
    working: false,
    lastSeq: 0,
  };
}

/**
 * Fold one event into the model.
 *
 * Pure: the same model and the same event always give the same result, which
 * is what makes a replayed gap produce the same screen.
 */
export function reduce(model: SessionModel, event: EvtFrame): SessionModel {
  const seq = Math.max(model.lastSeq, event.seq);

  switch (event.type) {
    case 'user.message': {
      const turn: Turn = {
        id: event.data.id,
        kind: 'user',
        text: event.data.text,
        preview: event.data.text,
        streaming: false,
        seq: event.seq,
        attachments: event.data.attachments,
      };
      return { ...model, lastSeq: seq, turns: upsert(model.turns, turn.id, turn), working: true };
    }

    case 'assistant.delta': {
      const existing = model.turns.get(event.data.messageId);
      const turn: Turn = existing
        ? { ...existing, preview: existing.preview + event.data.text, streaming: true }
        : {
            id: event.data.messageId,
            kind: 'assistant',
            text: '',
            preview: event.data.text,
            streaming: true,
            seq: event.seq,
          };
      return { ...model, lastSeq: seq, turns: upsert(model.turns, turn.id, turn) };
    }

    case 'assistant.message': {
      const existing = model.turns.get(event.data.messageId);
      const turn: Turn = existing
        ? {
            ...existing,
            // An assistant message can carry more than one text block, and
            // each arrives as its own event. The first one is the text; the
            // rest are additional blocks of the same message.
            text: existing.text
              ? `${existing.text}\n\n${event.data.text}`
              : event.data.text,
            streaming: true,
          }
        : {
            id: event.data.messageId,
            kind: 'assistant',
            text: event.data.text,
            preview: event.data.text,
            streaming: true,
            seq: event.seq,
          };
      return { ...model, lastSeq: seq, turns: upsert(model.turns, turn.id, turn) };
    }

    case 'assistant.thinking': {
      const existing = model.turns.get(event.data.messageId);
      const turn: Turn = existing
        ? { ...existing, text: `${existing.text}\n\n${event.data.text}`.trim() }
        : {
            id: event.data.messageId,
            kind: 'thinking',
            text: event.data.text,
            preview: event.data.text,
            streaming: false,
            seq: event.seq,
          };
      return { ...model, lastSeq: seq, turns: upsert(model.turns, turn.id, turn) };
    }

    case 'tool.call': {
      const tool: ToolCall = {
        toolUseId: event.data.toolUseId,
        name: event.data.name,
        displayName: event.data.displayName,
        input: event.data.input,
        seq: event.seq,
      };
      return { ...model, lastSeq: seq, tools: upsert(model.tools, tool.toolUseId, tool) };
    }

    case 'tool.result': {
      const existing = model.tools.get(event.data.toolUseId);
      if (!existing) {
        // A result for a call we never saw — the client attached mid-call.
        return { ...model, lastSeq: seq };
      }
      const tool: ToolCall = {
        ...existing,
        output: event.data.output,
        ok: event.data.ok,
        durationMs: event.data.durationMs,
      };
      return { ...model, lastSeq: seq, tools: upsert(model.tools, tool.toolUseId, tool) };
    }

    case 'permission.request': {
      const { data } = event;
      const pending: PendingPermission = {
        requestId: data.requestId,
        toolUseId: data.toolUseId,
        toolName: data.toolName,
        displayName: data.displayName,
        title: data.title,
        description: data.description,
        input: data.input,
        defaultToNo: data.defaultToNo,
        blockedPath: data.blockedPath,
        decisionReason: data.decisionReason,
        agentID: data.agentID,
        suggestions: data.suggestions,
        mcpServer: data.mcpServer,
      };
      return { ...model, lastSeq: seq, pending };
    }

    case 'permission.resolved': {
      // Only clear the request this actually answers.
      const pending =
        model.pending?.requestId === event.data.requestId ? undefined : model.pending;
      return { ...model, lastSeq: seq, pending };
    }

    case 'git.status': {
      const git: GitStatus = {
        branch: event.data.branch,
        ahead: event.data.ahead,
        behind: event.data.behind,
        changes: event.data.changes,
      };
      return { ...model, lastSeq: seq, git };
    }

    case 'session.idle': {
      // The turn is over: show the finished text rather than the preview.
      const turns = new Map(model.turns);
      for (const [id, turn] of turns) {
        if (turn.streaming) turns.set(id, { ...turn, streaming: false });
      }
      return { ...model, lastSeq: seq, turns, working: false };
    }

    case 'session.error': {
      return { ...model, lastSeq: seq, error: event.data.message, working: false };
    }

    default:
      return { ...model, lastSeq: seq };
  }
}

/**
 * The transcript, in order.
 *
 * Turns and tool calls are ordered by the sequence number of the event that
 * introduced them, which puts a tool call directly under the assistant
 * message that asked for it — the host publishes them in that order.
 */
export function transcript(model: SessionModel): (Turn | ToolCall)[] {
  return [...model.turns.values(), ...model.tools.values()].sort((a, b) => a.seq - b.seq);
}

/** The text a turn should show right now. */
export function turnText(turn: Turn): string {
  if (turn.streaming) return turn.preview || turn.text;
  return turn.text || turn.preview;
}

function upsert<T>(map: Map<string, T>, key: string, value: T): Map<string, T> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

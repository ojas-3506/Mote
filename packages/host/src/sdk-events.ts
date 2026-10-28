import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { CcrEvent } from '@ccr/protocol';

/**
 * Translate the Agent SDK's message stream into ccr events.
 *
 * The SDK's shapes are wide and versioned independently of ours, so this
 * mapper is deliberately defensive: anything it doesn't recognise is dropped
 * rather than allowed to throw and kill the session's event loop.
 *
 * It also carries a little state — the id of the message currently streaming —
 * because a delta arrives before the complete message that names it.
 */

/** The blocks we care about, narrowed locally so the SDK's wider union doesn't leak in. */
type ContentBlockLike =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown };

type ToolResultBlock = {
  type: 'tool_result';
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
};

export interface SdkEventMapperOptions {
  /** The ccr session id these events belong to. */
  sessionId: string;
  /** The host's id, echoed in `session.started`. */
  hostId: string;
  /** The Claude Code version the SDK is running. */
  claudeVersion: string;
}

export class SdkEventMapper {
  #options: SdkEventMapperOptions;
  /** The message id currently streaming, learned from `message_start`. */
  #streamingMessageId: string | null = null;

  constructor(options: SdkEventMapperOptions) {
    this.#options = options;
  }

  map(message: SDKMessage): CcrEvent[] {
    switch (message.type) {
      case 'system':
        return this.#mapSystem(message);
      case 'assistant':
        return this.#mapAssistant(message);
      case 'stream_event':
        return this.#mapStreamEvent(message);
      case 'user':
        return this.#mapUser(message);
      case 'result':
        return this.#mapResult(message);
      default:
        return [];
    }
  }

  #mapSystem(message: SDKMessage): CcrEvent[] {
    // Several SDK message kinds share `type: 'system'`, so the subtype is
    // what actually identifies the init message.
    const system = message as SDKSystemMessage;
    if (system.subtype !== 'init') return [];
    return [
      {
        type: 'session.started',
        data: {
          sessionId: this.#options.sessionId,
          hostId: this.#options.hostId,
          cwd: system.cwd,
          claudeSessionId: system.session_id,
          model: system.model,
          resumed: false,
          claudeVersion: this.#options.claudeVersion,
        },
      },
    ];
  }

  #mapAssistant(message: SDKAssistantMessage): CcrEvent[] {
    const events: CcrEvent[] = [];
    const messageId = message.message.id;
    const parentToolUseId = message.parent_tool_use_id ?? undefined;

    for (const block of message.message.content as unknown as ContentBlockLike[]) {
      switch (block.type) {
        case 'text': {
          events.push({
            type: 'assistant.message',
            data: {
              messageId,
              text: block.text ?? '',
              stopReason: message.message.stop_reason ?? undefined,
            },
          });
          break;
        }
        case 'thinking': {
          events.push({
            type: 'assistant.thinking',
            data: { messageId, text: block.thinking ?? '' },
          });
          break;
        }
        case 'tool_use': {
          events.push({
            type: 'tool.call',
            data: {
              toolUseId: block.id,
              name: block.name,
              displayName: block.name,
              input:
                block.input && typeof block.input === 'object'
                  ? (block.input as Record<string, unknown>)
                  : { value: block.input },
              parentToolUseId,
            },
          });
          break;
        }
        default:
          break;
      }
    }

    return events;
  }

  #mapStreamEvent(message: SDKPartialAssistantMessage): CcrEvent[] {
    const event = message.event as unknown as {
      type: string;
      message?: { id?: string };
      delta?: { type?: string; text?: string; thinking?: string };
    };

    if (event.type === 'message_start') {
      // The message id arrives before any of its content.
      this.#streamingMessageId = event.message?.id ?? null;
      return [];
    }

    if (event.type !== 'content_block_delta') return [];

    const delta = event.delta;
    if (delta?.type !== 'text_delta' || !delta.text) return [];

    return [
      {
        type: 'assistant.delta',
        data: {
          messageId: this.#streamingMessageId ?? 'streaming',
          text: delta.text,
        },
      },
    ];
  }

  #mapUser(message: SDKUserMessage): CcrEvent[] {
    const events: CcrEvent[] = [];
    const content = message.message.content;

    if (!Array.isArray(content)) return events;

    for (const block of content as unknown[]) {
      const typed = block as Partial<ToolResultBlock>;
      if (typed.type !== 'tool_result') continue;
      const toolResult = typed as ToolResultBlock;
      events.push({
        type: 'tool.result',
        data: {
          toolUseId: toolResult.tool_use_id,
          ok: !toolResult.is_error,
          output: stringifyToolResult(toolResult.content),
        },
      });
    }

    return events;
  }

  #mapResult(message: SDKResultMessage): CcrEvent[] {
    const events: CcrEvent[] = [];

    // A denial recorded by the CLI is authoritative even when no interactive
    // prompt was shown.
    for (const denial of message.permission_denials ?? []) {
      events.push({
        type: 'tool.result',
        data: {
          toolUseId: denial.tool_use_id,
          ok: false,
          output: `Denied: ${denial.tool_name}`,
        },
      });
    }

    if (message.is_error) {
      events.push({
        type: 'session.error',
        data: {
          code: message.subtype,
          // The error variant doesn't always carry a `result` string.
          message: 'result' in message && typeof message.result === 'string' ? message.result : 'The turn failed.',
          fatal: false,
        },
      });
    }

    events.push({ type: 'session.idle', data: { reason: 'turn_complete' } });
    return events;
  }
}

/**
 * Render a tool result's content as text.
 *
 * The content is arbitrary — a string, a list of blocks, or an object. It is
 * displayed on the phone, never interpreted, so a lossy but honest rendering
 * is the right trade.
 */
export function stringifyToolResult(content: unknown): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const record = part as Record<string, unknown>;
          if (typeof record.text === 'string') return record.text;
          if (record.type === 'image') return '[image]';
        }
        return JSON.stringify(part);
      })
      .join('\n');
  }
  if (typeof content === 'object') {
    try {
      return JSON.stringify(content, null, 2);
    } catch {
      return String(content);
    }
  }
  return String(content);
}

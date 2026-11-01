import { randomUUID } from 'node:crypto';
import { query, type CanUseTool, type PermissionResult, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  filterRemotelyGrantable,
  isRemotelySettableMode,
  type PermissionUpdate,
  type Priority,
} from '@mote/protocol';
import { PendingRequests, type Logger, type SessionStream, type Verdict, type VerdictSource } from '@mote/core';
import { AuditLog, hashInput } from './audit.js';
import { SdkEventMapper } from './sdk-events.js';

/**
 * One Claude Code session, owned by the host.
 *
 * The session is the only thing in Mote that talks to the Agent SDK. It turns
 * SDK messages into protocol events, accepts prompts from a phone, and — the
 * part that matters — relays permission requests to the phone and waits for a
 * verdict.
 */

/** The answer to a permission request, as the host holds it. */
export type PermissionAnswer =
  | {
      behavior: 'allow';
      updatedPermissions?: PermissionUpdate[];
      /** True when the grant persists for the session rather than applying once. */
      always: boolean;
    }
  | { behavior: 'deny'; message: string };

export function denyAnswer(message = 'Denied on the phone.'): PermissionAnswer {
  return { behavior: 'deny', message };
}

export interface SessionOptions {
  id: string;
  cwd: string;
  label: string;
  hostId: string;
  claudeVersion: string;
  stream: SessionStream;
  logger: Logger;
  audit: AuditLog;
  model?: string;
  resume?: string;
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'auto';
  permissionTimeoutMs?: number;
  /**
   * How to create the SDK query. Injectable so the permission flow — the part
   * of this project that can run code on someone's machine — can be tested
   * without spawning a real Claude Code process.
   */
  queryFactory?: QueryFactory;
}

export type QueryFactory = typeof query;

/** A queue of prompts waiting to be fed into the SDK's input stream. */
class MessageQueue<T> {
  static readonly CLOSED = Symbol('closed');

  #items: T[] = [];
  #waiters: Array<(item: T | typeof MessageQueue.CLOSED) => void> = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter(item);
    else this.#items.push(item);
  }

  close(): void {
    this.#closed = true;
    while (this.#waiters.length) this.#waiters.shift()!(MessageQueue.CLOSED);
  }

  #next(): Promise<T | typeof MessageQueue.CLOSED> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.#closed) return Promise.resolve(MessageQueue.CLOSED);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async *iterate(): AsyncGenerator<T> {
    while (true) {
      const item = await this.#next();
      if (item === MessageQueue.CLOSED) return;
      yield item;
    }
  }
}

interface PendingMeta {
  toolName: string;
  toolUseId: string;
  inputHash: string;
}

export class Session {
  readonly id: string;
  readonly cwd: string;
  readonly label: string;

  /** Sentinel for "the session is shutting down". */
  static readonly CLOSED = Symbol('closed');

  #options: SessionOptions;
  #stream: SessionStream;
  #logger: Logger;
  #audit: AuditLog;
  #mapper: SdkEventMapper;

  #query: Query | null = null;
  #input = new MessageQueue<SDKUserMessage>();
  #pending: PendingRequests<PermissionAnswer>;
  #pendingMeta = new Map<string, PendingMeta>();
  #consuming: Promise<void> | null = null;
  #started = false;
  #claudeSessionId: string | null = null;
  #closed = false;
  #abort = new AbortController();
  #resolveClosed!: (value: typeof Session.CLOSED) => void;
  #closedSignal: Promise<typeof Session.CLOSED>;

  constructor(options: SessionOptions) {
    this.#options = options;
    this.id = options.id;
    this.cwd = options.cwd;
    this.label = options.label;
    this.#stream = options.stream;
    this.#logger = options.logger.child(`session:${options.id}`);
    this.#audit = options.audit;
    this.#mapper = new SdkEventMapper({
      sessionId: options.id,
      hostId: options.hostId,
      claudeVersion: options.claudeVersion,
      resumed: options.resume !== undefined,
    });
    this.#pending = new PendingRequests<PermissionAnswer>({
      timeoutMs: options.permissionTimeoutMs ?? 15 * 60 * 1000,
      // Unanswered approvals fail closed. Never allow, never hang.
      onTimeout: () => denyAnswer('The approval timed out.'),
      // A request that ends without an answer leaves nothing behind: the
      // per-request state is dropped so it can't be applied to a later
      // prompt, and it doesn't accumulate for the life of the session.
      onEnded: (id) => {
        this.#pendingMeta.delete(id);
      },
    });
    this.#closedSignal = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get started(): boolean {
    return this.#started;
  }

  /** The Claude Code transcript id, once the CLI has reported it. */
  get claudeSessionId(): string | null {
    return this.#claudeSessionId;
  }

  get pendingApprovals(): number {
    return this.#pending.size;
  }

  /**
   * Start the Claude Code process if it isn't running.
   *
   * Starting lazily matters: `query()` spawns the CLI, and a host with three
   * workspaces shouldn't spawn three Claude processes the moment it boots.
   */
  async ensureStarted(): Promise<void> {
    if (this.#started || this.#closed) return;
    this.#started = true;
    await this.start();
  }

  /** Start the Claude Code process and begin consuming its messages. */
  async start(): Promise<void> {
    const factory = this.#options.queryFactory ?? query;
    this.#query = factory({
      prompt: this.#input.iterate(),
      options: {
        cwd: this.cwd,
        abortController: this.#abort,
        includePartialMessages: true,
        forwardSubagentText: true,
        // The host answers permission prompts. Without this the CLI would
        // deny anything it can't ask about, and `canUseTool` would never fire.
        permissionPrompts: 'host',
        permissionMode: this.#options.permissionMode ?? 'default',
        canUseTool: this.#canUseTool,
        model: this.#options.model,
        resume: this.#options.resume,
        stderr: (data: string) => {
          // The CLI's stderr can carry prompt-adjacent content. Log a length,
          // not the text.
          this.#logger.debug('sdk stderr', { bytes: data.length });
        },
      },
    });

    this.#consuming = this.#consume();
  }

  async #consume(): Promise<void> {
    const query = this.#query;
    if (!query) return;
    const iterator = query[Symbol.asyncIterator]();
    try {
      while (true) {
        // Race the iterator against the close signal. The SDK's iterator is
        // not guaranteed to end when the session is closed, and a consume
        // loop that never returns would hang the daemon's shutdown.
        const next = await Promise.race([iterator.next(), this.#closedSignal]);
        if (next === Session.CLOSED) break;
        if (next.done) break;
        for (const event of this.#mapper.map(next.value)) {
          if (event.type === 'session.started') {
            this.#claudeSessionId = event.data.claudeSessionId;
          }
          await this.#stream.publish(this.id, event);
        }
      }
    } catch (error) {
      this.#logger.error('session stream failed', { error: String(error) });
      await this.#stream.publish(this.id, {
        type: 'session.error',
        data: {
          code: 'sdk_error',
          message: error instanceof Error ? error.message : String(error),
          fatal: true,
        },
      });
    } finally {
      // A session that ends with approvals outstanding has failed them
      // closed — the agent is blocked on those promises.
      this.#pending.failAll(denyAnswer('The session ended.'));
      try {
        await iterator.return?.(undefined);
      } catch {
        // The iterator is already gone.
      }
    }
  }

  async sendPrompt(text: string, priority?: Priority): Promise<void> {
    if (this.#closed) throw new Error('session is closed');
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      priority,
    };
    this.#input.push(message);
    await this.#stream.publish(this.id, {
      type: 'user.message',
      data: {
        id: randomUUID(),
        text,
        priority: priority ?? 'now',
      },
    });
  }

  async interrupt(): Promise<void> {
    await this.#query?.interrupt();
    await this.#stream.publish(this.id, { type: 'session.idle', data: { reason: 'interrupted' } });
  }

  async setModel(model: string): Promise<void> {
    await this.#query?.setModel(model);
  }

  /**
   * Change the permission mode.
   *
   * `bypassPermissions` is refused. It is not "a mode we discourage" — it is
   * the mode in which the agent can do anything the user can, and it must not
   * be reachable by tapping a phone.
   */
  async setPermissionMode(mode: string): Promise<void> {
    if (!isRemotelySettableMode(mode)) {
      throw new Error(`permission mode "${mode}" cannot be set from a remote client`);
    }
    await this.#query?.setPermissionMode(mode);
  }

  /**
   * Answer a pending permission request.
   *
   * Returns `false` when the request is unknown, already answered, or timed
   * out — the caller answers the client with `no_such_request`.
   *
   * The audit entry is written *before* the verdict is delivered, so an
   * approval can never reach the agent without having been recorded. The
   * audit log's whole purpose is to prove what was approved; a verdict that
   * outruns its own record defeats that.
   *
   * A verdict for a request that is no longer pending is **not** recorded at
   * all. It was refused, and recording it would put an "allow" in the log for
   * a tool call that was actually denied — the one thing the log exists to
   * prevent someone from having to guess about.
   */
  async resolvePermission(
    requestId: string,
    decision: {
      behavior: 'allow' | 'deny';
      updatedPermissions?: PermissionUpdate[];
      message?: string;
    },
    actor: string,
  ): Promise<boolean> {
    const answer: PermissionAnswer =
      decision.behavior === 'allow'
        ? {
            behavior: 'allow',
            updatedPermissions: decision.updatedPermissions,
            always: (decision.updatedPermissions?.length ?? 0) > 0,
          }
        : { behavior: 'deny', message: decision.message ?? 'Denied on the phone.' };

    const meta = this.#pendingMeta.get(requestId);

    let settled: boolean;
    try {
      settled = await this.#pending.settle(requestId, answer, async () => {
        await this.#audit.append({
          ts: Date.now(),
          sessionId: this.id,
          actor,
          kind: 'permission.resolve',
          toolName: meta?.toolName,
          toolUseId: meta?.toolUseId,
          decision: answer.behavior,
          always: answer.behavior === 'allow' ? answer.always : undefined,
          inputHash: meta?.inputHash,
          by: 'phone',
        });
      });
    } catch (error) {
      // The record could not be written, so the approval was refused and the
      // agent has already been denied. Say so rather than leaving the caller
      // to wonder why the request vanished.
      this.#logger.error('audit write failed; the approval was denied', {
        requestId,
        error: String(error),
      });
      this.#pendingMeta.delete(requestId);
      return false;
    }

    if (!settled) return false;

    this.#pendingMeta.delete(requestId);
    return true;
  }

  /**
   * The SDK's permission callback.
   *
   * Fires only when permission evaluation falls through to a prompt — calls
   * already covered by allow rules or the active permission mode don't reach
   * it.
   */
  #canUseTool: CanUseTool = async (toolName, input, options) => {
    const requestId = randomUUID();

    // Only suggestions a remote approval may actually grant are offered.
    // The SDK's `suggestions` is a privilege-escalation surface otherwise.
    const suggestions = options.suppressAlwaysAllowRule
      ? []
      : filterRemotelyGrantable(options.suggestions ?? []);

    const meta: PendingMeta = {
      toolName,
      toolUseId: options.toolUseID,
      inputHash: hashInput(input),
    };
    this.#pendingMeta.set(requestId, meta);

    await this.#stream.publish(this.id, {
      type: 'permission.request',
      data: {
        requestId,
        toolUseId: options.toolUseID,
        toolName,
        displayName: options.displayName ?? toolName,
        // The SDK's full prompt sentence is the primary text. A summary is
        // where an injection hides — SECURITY.md §5.
        title: options.title ?? `Claude wants to use ${toolName}`,
        description: options.description ?? '',
        input,
        // Fail closed: if the SDK doesn't say, assume the ask must not be
        // approvable by a stray keystroke.
        defaultToNo: options.defaultToNo ?? true,
        suggestions,
        mcpServer: options.mcpServer,
        // The context the SDK gives about *why* it is asking. Dropping it
        // would leave the phone showing a bare tool name and an input blob.
        blockedPath: options.blockedPath,
        decisionReason: options.decisionReason,
        agentID: options.agentID,
      },
    });

    const verdict = await this.#awaitVerdict(requestId, options.signal);
    const answer = verdict.value;

    // A verdict a person gave is recorded by `resolvePermission`, before the
    // verdict is delivered. A verdict *nobody* gave — a timeout, a
    // disconnect, an interrupted turn — is recorded here, because the log
    // has to show what was not approved as well as what was. A tool call
    // that timed out is a tool call that did not run, and the user should
    // not have to infer that from a missing line.
    if (verdict.by !== 'phone') {
      await this.#recordDenial(requestId, meta, verdict.by);
    }

    await this.#stream.publish(this.id, {
      type: 'permission.resolved',
      data: {
        requestId,
        behavior: answer.behavior,
        by: verdict.by,
      },
    });

    if (answer.behavior === 'allow') {
      // Re-filter on the way back. The client is authenticated, but the
      // protocol allows it to send any PermissionUpdate shape, and one of
      // those shapes can grant everything.
      const granted = filterRemotelyGrantable(answer.updatedPermissions ?? []);
      const result: PermissionResult = {
        behavior: 'allow',
        // `updatedInput` from a remote client is deliberately ignored: the
        // input shown in the prompt must be the input that runs.
        updatedPermissions: granted.length > 0 ? granted : undefined,
        toolUseID: options.toolUseID,
        decisionClassification: granted.length > 0 ? 'user_permanent' : 'user_temporary',
      };
      return result;
    }

    const result: PermissionResult = {
      behavior: 'deny',
      message: answer.message,
      toolUseID: options.toolUseID,
      decisionClassification: 'user_reject',
    };
    return result;
  };

  /**
   * Record a denial that no person chose.
   *
   * A failed write here must not break the turn: the tool has already been
   * refused, and the agent is waiting on the callback's return value.
   */
  async #recordDenial(
    requestId: string,
    meta: PendingMeta,
    by: VerdictSource,
  ): Promise<void> {
    try {
      await this.#audit.append({
        ts: Date.now(),
        sessionId: this.id,
        actor: 'host',
        kind: 'permission.resolve',
        toolName: meta.toolName,
        toolUseId: meta.toolUseId,
        decision: 'deny',
        inputHash: meta.inputHash,
        by,
      });
    } catch (error) {
      this.#logger.error('audit write failed', { requestId, error: String(error) });
    }
  }

  /**
   * Wait for a verdict, racing the turn's abort signal.
   *
   * An interrupted turn must not leave the approval hanging — the agent is
   * blocked on the promise.
   */
  async #awaitVerdict(requestId: string, signal: AbortSignal): Promise<Verdict<PermissionAnswer>> {
    const pending = this.#pending.request(requestId);

    const aborted = new Promise<Verdict<PermissionAnswer>>((resolve) => {
      const settle = () => resolve({ value: denyAnswer('The turn was interrupted.'), by: 'host' });
      if (signal.aborted) {
        settle();
        return;
      }
      signal.addEventListener('abort', settle, { once: true });
    });

    const verdict = await Promise.race([pending, aborted]);

    if (verdict.by === 'host') {
      // The abort won the race. Drop the pending entry so a late answer from
      // the phone is rejected rather than applied to a later prompt.
      await this.#pending.settle(requestId, verdict.value);
    }

    return verdict;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;

    // Fail every outstanding approval closed before anything else: the agent
    // is blocked on those promises.
    this.#pending.failAll(denyAnswer('The session was closed.'));
    this.#input.close();

    // Signal both the SDK and our own consume loop.
    this.#abort.abort();
    this.#resolveClosed(Session.CLOSED);

    // Wait for the loop to unwind, but never hang the daemon on it.
    await Promise.race([
      Promise.all([this.#consuming ?? Promise.resolve(), this.#query?.close() ?? Promise.resolve()]),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

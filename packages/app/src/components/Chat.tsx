import { useMemo } from 'react';
import type { SessionModel } from '../lib/session-model';
import { transcript } from '../lib/session-model';
import { Message } from './Message';
import { ToolCallRow } from './ToolCall';

/**
 * The transcript.
 *
 * Turns and tool calls share one list, ordered by the sequence number that
 * introduced them — which puts a tool call directly under the message that
 * asked for it, because the host publishes them in that order.
 */
export function Chat({ model }: { model: SessionModel }) {
  const items = useMemo(() => transcript(model), [model]);

  if (items.length === 0) {
    return (
      <div className="events">
        <p className="muted small empty">
          Nothing yet. Say something to start the session.
        </p>
      </div>
    );
  }

  return (
    <div className="events">
      {items.map((item) =>
        'toolUseId' in item ? (
          <ToolCallRow key={item.toolUseId} tool={item} />
        ) : (
          <Message key={item.id} turn={item} />
        ),
      )}
    </div>
  );
}

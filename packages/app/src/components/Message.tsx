import type { Turn } from '../lib/session-model';
import { turnText } from '../lib/session-model';

/**
 * One turn in the transcript.
 *
 * Everything here is rendered as text. A tool's output, a file's contents, a
 * command's output — all of it came from somewhere the user may not
 * control, so it is shown and never interpreted. React escapes it by
 * default, and there is deliberately no linkifier: a URL that appears in
 * tool input must not become something the phone fetches.
 */
export function Message({ turn }: { turn: Turn }) {
  if (turn.kind === 'thinking') {
    return (
      <div className="message thinking">
        <details>
          <summary>Thinking</summary>
          <p>{turn.text}</p>
        </details>
      </div>
    );
  }

  return (
    <div className={`message ${turn.kind}`}>
      <p>{turnText(turn)}</p>
      {turn.attachments && turn.attachments.length > 0 && (
        <ul className="attachments">
          {turn.attachments.map((attachment) => (
            <li key={attachment.name}>
              {attachment.name} ({attachment.mimeType}, {attachment.size} bytes)
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

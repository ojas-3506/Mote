import { useState } from 'react';
import type { ToolCall } from '../lib/session-model';
import { safeJson, summariseInput, truncate } from '../lib/format';

/**
 * A tool call: a collapsed row that opens into the full input and output.
 *
 * The row is collapsed by default because a tool input can be a whole file.
 * When it opens, the input is shown **in full** — a permission surface that
 * shows a summary is a surface nobody can decide on — and the output is
 * capped, with the amount elided stated rather than hidden.
 */
export function ToolCallRow({ tool }: { tool: ToolCall }) {
  const [open, setOpen] = useState(false);

  const running = tool.output === undefined;
  const output = tool.output === undefined ? undefined : truncate(tool.output);

  return (
    <div className={`tool${open ? ' open' : ''}`}>
      <button type="button" className="tool-head" onClick={() => setOpen(!open)}>
        <span className={`tool-status ${statusClass(tool)}`} aria-hidden="true" />
        <span className="tool-name">{tool.displayName}</span>
        <span className="tool-summary">{summariseInput(tool.input)}</span>
        {tool.durationMs !== undefined && (
          <span className="tool-duration">{formatDuration(tool.durationMs)}</span>
        )}
      </button>

      {open && (
        <div className="tool-body">
          <p className="muted small">Input</p>
          <pre className="input">{safeJson(tool.input)}</pre>

          {running ? (
            <p className="muted small">Running…</p>
          ) : (
            <>
              <p className="muted small">Output</p>
              <pre className="input">{output?.text}</pre>
              {output && output.elided > 0 && (
                <p className="muted small">
                  {output.elided.toLocaleString()} more characters are not shown.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function statusClass(tool: ToolCall): string {
  if (tool.output === undefined) return 'running';
  return tool.ok ? 'ok' : 'failed';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

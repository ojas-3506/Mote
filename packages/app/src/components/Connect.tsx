import { useState } from 'react';

/**
 * The first screen: a token.
 *
 * The normal way in is the URL the host prints — it carries the token in the
 * fragment, so this screen is the fallback for a phone that opened the app
 * from the home screen instead of the link.
 */
export function Connect({ onConnect }: { onConnect: (token: string) => void }) {
  const [value, setValue] = useState('');

  return (
    <main className="screen">
      <form
        className="card"
        onSubmit={(event) => {
          event.preventDefault();
          const token = value.trim();
          if (token) onConnect(token);
        }}
      >
        <h1>Mote</h1>
        <p className="muted">
          Open the link your host printed. It carries the token in the address
          after the <code>#</code>, which never reaches the network.
        </p>
        <label className="field">
          <span>Token</span>
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="paste the token"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={!value.trim()}>
          Connect
        </button>
      </form>
    </main>
  );
}

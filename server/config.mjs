// What the server is told by its environment, checked before anything listens.
//
// The rule that matters: the dashboard shows client ticket text, and this version
// has no sign-in. With no authentication configured the server therefore only
// starts on a loopback address, and says why. Configuring authentication is what
// lifts that, not removing this check.

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

const refuse = (message) => Object.assign(new Error(message), { config: true });

/**
 * @param {Record<string, string|undefined>} env
 * @returns {{databaseUrl: string, publicUrl: URL, bind: {host: string, port: number}}}
 */
export function readConfig(env) {
  if (!env.DATABASE_URL) throw refuse('DATABASE_URL is not set.');
  if (!env.PUBLIC_URL) throw refuse('PUBLIC_URL is not set. It is the address people open, for example http://127.0.0.1:3900.');

  let url;
  try {
    url = new URL(env.PUBLIC_URL);
  } catch {
    throw refuse(`PUBLIC_URL is not a URL: ${env.PUBLIC_URL}`);
  }
  if (url.username || url.password) throw refuse('PUBLIC_URL must not carry credentials.');
  if (url.pathname !== '/' || url.search || url.hash) throw refuse('PUBLIC_URL is an origin: no path, no query, no fragment.');

  const authConfigured = false; // sign-in does not exist yet
  if (!authConfigured) {
    // Compared whole. "127.0.0.1.example.com" starts with a loopback address and is not one.
    if (url.protocol !== 'http:' || !LOOPBACK.has(url.hostname)) {
      throw refuse(`No sign-in is configured, so this server only starts on a loopback address. PUBLIC_URL is ${url.origin}; use http://127.0.0.1:<port>. It would otherwise publish ticket text to anyone who can reach it.`);
    }
    if (!url.port) throw refuse('PUBLIC_URL needs a port, for example http://127.0.0.1:3900.');
    // The address is fixed here, never read from the environment: a stray HOST=0.0.0.0 must not open it up.
    return { databaseUrl: env.DATABASE_URL, publicUrl: url, bind: { host: '127.0.0.1', port: Number(url.port) } };
  }
  throw refuse('Unreachable until sign-in exists.');
}

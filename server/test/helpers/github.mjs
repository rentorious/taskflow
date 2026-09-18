// A stand-in for GitHub's OAuth endpoints, strict about the parts that matter:
// it only hands out a token for a code it issued, to the right client, with the
// PKCE verifier that matches the challenge it was shown.

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

export async function fakeGithub({ clientId = 'test-client', clientSecret = 'test-secret' } = {}) {
  const codes = new Map();  // code -> { challenge, redirectUri, profile }
  const tokens = new Map(); // access token -> profile
  const seen = { authorize: [], scopes: [] };
  let nextProfile = null;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://github.test');
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

    if (url.pathname === '/login/oauth/authorize') {
      const q = url.searchParams;
      seen.authorize.push(Object.fromEntries(q));
      seen.scopes.push(q.get('scope'));
      if (q.get('client_id') !== clientId || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state')) return json(400, { error: 'bad authorize request' });
      const code = randomBytes(8).toString('hex');
      codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), profile: nextProfile });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: back.href });
      return res.end();
    }

    if (url.pathname === '/login/oauth/access_token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const sent = JSON.parse(body || '{}');
      const issued = codes.get(sent.code);
      codes.delete(sent.code); // single use
      const verifierOk = issued && createHash('sha256').update(String(sent.code_verifier ?? '')).digest('base64url') === issued.challenge;
      if (!issued || sent.client_id !== clientId || sent.client_secret !== clientSecret || sent.redirect_uri !== issued.redirectUri || !verifierOk) return json(200, { error: 'bad_verification_code' });
      const token = `gho_${randomBytes(12).toString('hex')}`;
      tokens.set(token, issued.profile);
      return json(200, { access_token: token, token_type: 'bearer', scope: '' });
    }

    if (url.pathname === '/user') {
      const profile = tokens.get(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!profile || !req.headers['user-agent']) return json(401, { message: 'Bad credentials' });
      return json(200, profile);
    }
    json(404, { message: 'Not Found' });
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    clientId,
    clientSecret,
    seen,
    endpoints: { authorizeUrl: `${base}/login/oauth/authorize`, tokenUrl: `${base}/login/oauth/access_token`, userUrl: `${base}/user` },
    /** Who the next person to reach the authorize page turns out to be. */
    as(profile) { nextProfile = profile; },
    close: () => new Promise((done) => server.close(done)),
  };
}

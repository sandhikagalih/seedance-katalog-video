import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest();
const COOKIE = 'team_session';
const SESSION_MS = 12 * 60 * 60 * 1000;

export function installAuth(app, config) {
  const sessions = new Map();
  const configured = Boolean(config.adminEmail && config.adminPassword);
  const emailHash = digest(config.adminEmail || '');
  const passwordHash = digest(config.adminPassword || '');
  // Batas global cocok untuk satu akun tim, tanpa mempercayai header IP proxy.
  let failures = 0;
  let retryAt = 0;
  const cookieOptions = req => ({ httpOnly: true, sameSite: 'strict',
    secure: Boolean(config.secureCookies || req.secure), path: '/' });
  const tokenFrom = req => (req.headers.cookie || '').split(';')
    .map(value => value.trim()).find(value => value.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);

  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    const now = Date.now();
    for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
    req.sessionToken = tokenFrom(req);
    req.authenticated = sessions.has(req.sessionToken);
    next();
  });
  app.get('/login', (req, res) => {
    if (req.authenticated) return res.redirect('/');
    res.sendFile(path.join(config.root, 'public', 'login.html'));
  });
  for (const file of ['login.js', 'styles.css']) {
    app.get(`/${file}`, (_req, res) => res.sendFile(path.join(config.root, 'public', file)));
  }
  app.post('/api/login', (req, res) => {
    if (!configured) return res.status(503).json({ error: 'Login belum dikonfigurasi. Isi ADMIN_EMAIL dan ADMIN_PASSWORD di .env server.' });
    const now = Date.now();
    if (now >= retryAt) { failures = 0; retryAt = now + 60_000; }
    if (failures >= 10) {
      res.setHeader('Retry-After', Math.ceil((retryAt - now) / 1000));
      return res.status(429).json({ error: 'Terlalu banyak percobaan login. Coba lagi setelah satu menit.' });
    }
    const { email, password } = req.body || {};
    const emailOK = timingSafeEqual(digest(typeof email === 'string' ? email : ''), emailHash);
    const passwordOK = timingSafeEqual(digest(typeof password === 'string' ? password : ''), passwordHash);
    if (!emailOK || !passwordOK) {
      failures++;
      return res.status(401).json({ error: 'Email atau password salah.' });
    }
    // Token baru pada setiap login; token lama pada browser ini dicabut.
    sessions.delete(req.sessionToken);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, now + SESSION_MS);
    res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_MS });
    res.json({ ok: true });
  });
  app.use((req, res, next) => {
    if (req.authenticated) return next();
    if (req.path === '/api' || req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'Silakan login terlebih dahulu.' });
    }
    res.redirect('/login');
  });
  app.post('/api/logout', (req, res) => {
    sessions.delete(req.sessionToken);
    res.clearCookie(COOKIE, cookieOptions(req));
    res.json({ ok: true });
  });
}

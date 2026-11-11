import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// API key sengaja hanya dibaca dari file .env, tidak dari browser / request.
const envPath = path.join(root, '.env');
const env = fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {};
const duration = Number(env.VIDEO_DURATION || 5);
const resolution = env.VIDEO_RESOLUTION || '480p';
const kursUsdIdr = env.KURS_USD_IDR?.trim() ? Number(env.KURS_USD_IDR) : null;
if (kursUsdIdr !== null && (!Number.isFinite(kursUsdIdr) || kursUsdIdr <= 0)) throw new Error('KURS_USD_IDR harus angka positif.');
if (!Number.isInteger(duration) || duration < 4 || duration > 30) throw new Error('VIDEO_DURATION harus 4–30.');
if (!['480p', '720p', '1080p'].includes(resolution)) throw new Error('VIDEO_RESOLUTION harus 480p, 720p, atau 1080p.');

export const config = {
  root,
  photoDir: path.join(root, 'foto-produk'),
  videoDir: path.join(root, 'videos'),
  dbPath: path.join(root, 'data', 'katalog.sqlite'),
  apiKey: env.ARK_API_KEY || '',
  adminEmail: env.ADMIN_EMAIL || '',
  adminPassword: env.ADMIN_PASSWORD || '',
  secureCookies: env.SESSION_COOKIE_SECURE === 'true',
  kursUsdIdr,
  baseUrl: (env.ARK_BASE_URL || 'https://ark.ap-southeast.bytepluses.com/api/v3').replace(/\/$/, ''),
  model: env.ARK_MODEL || 'dreamina-seedance-2-5-260628',
  duration,
  resolution,
  port: Number(env.PORT || 3000),
  host: env.HOST || '127.0.0.1',
  pollMs: 10_000,
  retryMs: 15_000,
  requestTimeoutMs: 60_000,
  downloadTimeoutMs: 120_000,
};

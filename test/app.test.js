import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { openDatabase } from '../lib/db.js';
import { Worker } from '../lib/worker.js';
import { createApp } from '../lib/app.js';
import { validateImage } from '../lib/seedance.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
const successful = { status: 'succeeded', content: { video_url: 'https://video.test/result.mp4' }, usage: { completion_tokens: 1234 }, duration: 5, resolution: '480p' };

async function fixture(t, fakeFetch, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wpu-video-test-'));
  const config = { root: path.resolve('.'), photoDir: path.join(dir, 'photos'), videoDir: path.join(dir, 'videos'), dbPath: path.join(dir, 'data', 'test.sqlite'),
    adminEmail: 'team@example.test', adminPassword: 'test-team-password',
    apiKey: 'TEST-SECRET-ONLY-SERVER', model: 'test-model', baseUrl: 'https://api.test', duration: 5, resolution: '480p', pollMs: 5, retryMs: 15, requestTimeoutMs: 1000, downloadTimeoutMs: 1000, ...overrides };
  await fs.mkdir(config.photoDir, { recursive: true });
  const image = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#087e80' } }).png().toBuffer();
  for (const filename of ['one.png', 'two.png', 'logo-wpustore-teal.png']) await fs.writeFile(path.join(config.photoDir, filename), image);
  await fs.writeFile(path.join(config.photoDir, 'katalog.json'), JSON.stringify([
    { slug: 'produk-awal', nama: 'Hoodie WPU', kategori: 'Hoodie', deskripsi: 'Fleece navy', foto: ['one.png', 'two.png'] },
  ]));
  const db = openDatabase(config);
  const worker = new Worker(db, config, fakeFetch);
  const server = createApp(db, worker, config).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await worker.stop();
    await new Promise(resolve => server.close(resolve));
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: config.adminEmail, password: config.adminPassword }) });
  const cookie = login.headers.get('set-cookie')?.split(';')[0] || '';
  const request = (route, options = {}) => fetch(`${base}${route}`, {
    ...options, headers: { Cookie: cookie, ...options.headers },
  });
  return { db, worker, config, base, image, cookie, request };
}

async function waitFor(predicate, timeout = 6000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeout) throw new Error('Timeout menunggu worker');
    await sleep(10);
  }
}

function post(f, route, body = {}) {
  return f.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

test('login mengunci halaman, aset, dan semua endpoint mutasi; logout mencabut session', async t => {
  let calls = 0;
  const f = await fixture(t, async () => { calls++; });
  for (const route of ['/', '/index.html', '/app.js', '/foto-produk/one.png', '/videos/test.mp4', '/halaman-lain']) {
    const response = await fetch(`${f.base}${route}`, { redirect: 'manual' });
    assert.equal(response.status, 302, route);
    assert.equal(response.headers.get('location'), '/login');
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  for (const route of ['/api/state', '/api/generate-all', '/api/products', '/api/products/1/generate', '/api/attempts/1/retry', '/api/logout']) {
    const response = await fetch(`${f.base}${route}`, { method: route === '/api/state' ? 'GET' : 'POST' });
    assert.equal(response.status, 401, route);
    assert.match((await response.json()).error, /login/);
  }
  assert.equal(calls, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 0);
  assert.equal((await fetch(`${f.base}/login`)).status, 200);
  assert.equal((await fetch(`${f.base}/login.js`)).status, 200);
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/foto-produk/one.png')).status, 200);
  const state = await (await f.request('/api/state')).text();
  assert.ok(!state.includes(f.config.adminEmail));
  assert.ok(!state.includes(f.config.adminPassword));
  assert.equal((await fetch(`${f.base}/api/state`, { headers: { Cookie: 'team_session=forged' } })).status, 401);
  assert.equal((await post(f, '/api/login', { email: f.config.adminEmail, password: 'wrong' })).status, 401);
  assert.equal((await post(f, '/api/login', { email: [], password: {} })).status, 401);
  assert.equal((await f.request('/api/logout', { method: 'POST', headers: { Origin: 'https://other.test' } })).status, 403);
  const logout = await post(f, '/api/logout');
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  assert.equal((await f.request('/api/state')).status, 401);
});

test('cookie httpOnly, SameSite, Secure, rotasi token, dan kedaluwarsa session', async t => {
  const f = await fixture(t, async () => {}, { secureCookies: true });
  const response = await post(f, '/api/login', { email: f.config.adminEmail, password: f.config.adminPassword });
  const header = response.headers.get('set-cookie');
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, /Secure/);
  assert.match(header, /Path=\//);
  assert.match(header, /Max-Age=43200/);
  const cookie = header.split(';')[0];
  assert.notEqual(cookie, f.cookie);
  assert.equal((await f.request('/api/state')).status, 401);
  assert.equal((await fetch(`${f.base}/api/state`, { headers: { Cookie: cookie } })).status, 200);
  const future = Date.now() + 12 * 60 * 60 * 1000 + 1000;
  const clock = t.mock.method(Date, 'now', () => future);
  try {
    assert.equal((await fetch(`${f.base}/api/state`, { headers: { Cookie: cookie } })).status, 401);
  } finally { clock.mock.restore(); }
});

test('konfigurasi admin kosong tetap terkunci dan percobaan login dibatasi', async t => {
  const missing = await fixture(t, async () => {}, { adminPassword: '' });
  assert.equal((await post(missing, '/api/login')).status, 503);
  assert.equal((await missing.request('/api/state')).status, 401);
  const f = await fixture(t, async () => {});
  for (let i = 0; i < 10; i++) assert.equal((await post(f, '/api/login', { email: f.config.adminEmail, password: 'wrong' })).status, 401);
  const limited = await post(f, '/api/login', { email: f.config.adminEmail, password: f.config.adminPassword });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
});

test('laporan biaya: kategori, resolusi, kurs, semua biaya per video, dan deduplikasi task retry', async t => {
  const f = await fixture(t, async () => { throw new Error('Laporan tidak boleh memanggil API'); }, { kursUsdIdr: 16000 });
  const product = f.db.prepare('SELECT * FROM products').get();
  f.db.prepare('UPDATE products SET name=? WHERE id=?').run('=FORMULA,"Produk"', product.id);
  function add(category, tokens, resolution = '480p', status = 'succeeded', duration = 5, taskId = undefined) {
    const jobId = f.worker.createJob(product, { ratio: '16:9', duration, costCategory: category });
    f.db.prepare('UPDATE jobs SET status=?,resolution=? WHERE id=?').run(status, resolution, jobId);
    const task = taskId === undefined ? `report-${jobId}` : taskId;
    f.db.prepare(`INSERT INTO attempts (job_id,number,task_id,status,started_at,duration,resolution,completion_tokens,video_file)
      VALUES (?,1,?,?,?,?,?,?,?)`).run(jobId, task, status, new Date().toISOString(), duration, resolution, tokens, status === 'succeeded' ? `${task}.mp4` : null);
    return jobId;
  }
  add('product', 100);
  add('test', 200, '720p');
  add('product', 300, '1080p', 'failed');
  const revisionId = add('revision', 400, '1080p', 'succeeded', 12);
  const retryId = add('product', 500, '480p', 'failed');
  f.db.prepare(`INSERT INTO attempts (job_id,number,task_id,status,started_at,duration,resolution,completion_tokens,video_file)
    VALUES (?,2,?,'succeeded',?,5,'480p',500,?)`).run(retryId, `report-${retryId}`, new Date().toISOString(), `report-${retryId}.mp4`);
  f.db.prepare("UPDATE jobs SET status='succeeded' WHERE id=?").run(retryId);
  add('product', 50, '720p', 'running');
  add('test', null, '480p', 'failed', 5, null);
  add('product', 0);
  const response = await f.request('/api/cost-report');
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.label, 'HASIL TES');
  assert.equal(report.rows.length, 8);
  assert.equal(report.totals.completedVideos, 4);
  assert.equal(report.totals.totalDuration, 27);
  assert.equal(report.totals.completionTokens, 1550);
  const packageTokens = 850 * 1.671875 + 700 * 1.828125;
  assert.equal(report.totals.packageTokens, packageTokens);
  assert.ok(Math.abs(report.totals.usd - packageTokens * 6.4 / 1_000_000) < 1e-12);
  assert.equal(report.totals.idr, report.totals.usd * 16000);
  assert.equal(report.totals.averageUsd, report.totals.usd / 4);
  assert.equal(report.totals.averageIdr, report.totals.usd * 16000 / 4);
  assert.equal(report.totals.missingTokens, 1);
  assert.deepEqual(Object.fromEntries(report.groups.map(g => [g.category, g.completionTokens])), { product: 600, test: 200, failed: 300, revision: 400, pending: 50 });
  assert.equal(report.rows.find(row => row.jobId === retryId).attemptIds.length, 2);
  assert.deepEqual(report.videoSpecs, [{ duration: 5, resolution: '480p', count: 3, totalDuration: 15 }, { duration: 12, resolution: '1080p', count: 1, totalDuration: 12 }]);
  const csvResponse = await f.request('/api/cost-report.csv');
  assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
  assert.match(csvResponse.headers.get('content-disposition'), /attachment.*laporan-biaya-hasil-tes.csv/);
  const csv = await csvResponse.text();
  assert.match(csv, /HASIL TES/);
  assert.ok(csv.includes(`"${report.totals.packageTokens}"`));
  assert.ok(csv.includes('"\'=FORMULA,""Produk"""'));
  const changed = await f.request(`/api/jobs/${revisionId}/cost-category`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ costCategory: 'test' }) });
  assert.equal(changed.status, 200);
  const updated = await (await f.request('/api/cost-report')).json();
  assert.equal(updated.totals.completedVideos, 3);
  assert.equal(updated.totals.usd, report.totals.usd);
  assert.equal(updated.groups.find(g => g.category === 'test').completionTokens, 600);
  assert.equal((await f.request(`/api/jobs/${revisionId}/cost-category`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"costCategory":"invalid"}' })).status, 400);
  assert.equal((await f.request('/api/jobs/99999/cost-category', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"costCategory":"test"}' })).status, 404);
  for (const route of ['/api/cost-report', '/api/cost-report.csv']) assert.equal((await fetch(`${f.base}${route}`)).status, 401);
  assert.equal((await fetch(`${f.base}/api/jobs/${revisionId}/cost-category`, { method: 'PATCH' })).status, 401);
});

test('laporan kosong tanpa kurs tidak menghasilkan NaN atau pembagian nol; migrasi kategori mempertahankan data', async t => {
  const f = await fixture(t, async () => {});
  const empty = await (await f.request('/api/cost-report')).json();
  assert.equal(empty.totals.completedVideos, 0);
  assert.equal(empty.totals.usd, 0);
  assert.equal(empty.totals.idr, null);
  assert.equal(empty.totals.averageUsd, null);
  assert.equal(empty.totals.averageIdr, null);
  const product = f.db.prepare('SELECT * FROM products').get();
  const id = f.worker.createJob(product, { ratio: '9:16', costCategory: 'test' });
  f.db.exec('ALTER TABLE jobs DROP COLUMN cost_category');
  const reopened = openDatabase(f.config);
  assert.equal(reopened.prepare('SELECT cost_category FROM jobs WHERE id=?').get(id).cost_category, 'product');
  assert.equal(reopened.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
  reopened.close();
  const twice = openDatabase(f.config);
  assert.equal(twice.prepare('SELECT COUNT(*) n FROM jobs').get().n, 1);
  twice.close();
});

test('bulk parallel, payload 3 Base64, download lokal, usage, tanpa bocor key, dan tidak duplikat', async t => {
  const bodies = [];
  let posts = 0;
  let polls = 0;
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') {
      bodies.push(JSON.parse(options.body));
      const id = ++posts;
      // POST pertama baru selesai bila POST kedua sudah dikirim: bukti parallel.
      await waitFor(() => posts === 2);
      return json({ id: `task-${id}` });
    }
    if (url.startsWith('https://video.test')) return new Response(Buffer.from('test-mp4'));
    polls++;
    return json(polls <= 2 ? { status: 'running' } : successful);
  });
  assert.equal((await post(f, '/api/generate-all')).status, 202);
  await waitFor(() => f.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='succeeded'").get().n === 2);
  assert.equal(posts, 2);
  assert.deepEqual(bodies.map(b => b.ratio).sort(), ['16:9', '9:16']);
  for (const b of bodies) {
    assert.equal(b.duration, 5); assert.equal(b.resolution, '480p');
    assert.equal(b.generate_audio, true); assert.equal(b.watermark, false);
    assert.match(b.content[0].text, /Hoodie WPU/);
    assert.match(b.content[0].text, /@Image1.*@Image2.*@Image3/);
    assert.equal(b.content.length, 4);
    for (const c of b.content.slice(1)) { assert.equal(c.role, 'reference_image'); assert.match(c.image_url.url, /^data:image\/png;base64,/); }
  }
  for (const task of f.db.prepare('SELECT * FROM attempts').all()) {
    assert.equal(task.completion_tokens, 1234);
    assert.ok(task.started_at && task.finished_at);
    assert.equal(await fs.readFile(path.join(f.config.videoDir, `${task.task_id}.mp4`), 'utf8'), 'test-mp4');
    assert.equal((await f.request(`/videos/${task.task_id}.mp4`)).status, 200);
  }
  const result = await (await post(f, '/api/generate-all')).json();
  assert.deepEqual(result.jobIds, []);
  const state = await (await f.request('/api/state')).text();
  assert.ok(!state.includes(f.config.apiKey));
  assert.equal((await f.request('/.env')).status, 404);
});

test('429, 5xx dan timeout: maksimal 2 retry, satu baris setiap percobaan', async t => {
  for (const kind of ['429', '503', 'timeout', 'connection']) {
    await t.test(kind, async t => {
      let calls = 0;
      const f = await fixture(t, async () => {
        calls++;
        if (kind === 'timeout') throw new DOMException('The operation timed out', 'TimeoutError');
        if (kind === 'connection') throw new TypeError('fetch failed');
        return json({ error: { code: 'temporary', message: 'Pesan API persis\nbaris dua' } }, Number(kind));
      });
      const product = f.db.prepare('SELECT * FROM products').get();
      const id = f.worker.createJob(product, { ratio: '16:9' }); f.worker.kick();
      await waitFor(() => f.db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status === 'failed');
      assert.equal(calls, 3);
      const rows = f.db.prepare('SELECT * FROM attempts ORDER BY number').all();
      assert.deepEqual(rows.map(r => r.number), [1, 2, 3]);
      assert.ok(rows.every(r => r.status === 'failed' && r.finished_at));
      if (kind !== 'timeout' && kind !== 'connection') assert.equal(rows[0].error_message, 'Pesan API persis\nbaris dua');
      for (let i = 1; i < rows.length; i++) assert.ok(Date.parse(rows[i].started_at) - Date.parse(rows[i - 1].finished_at) >= f.config.retryMs - 1);
    });
  }
});

test('input invalid tidak retry, pesan API utuh, retry manual menambah job dan mencegah klik ganda', async t => {
  let calls = 0;
  const errorMessage = 'Invalid image: wajah asli ditolak.\nDetail: @Image1';
  const f = await fixture(t, async () => { calls++; return json({ error: { code: 'InvalidParameter.Image', message: errorMessage } }, 400); });
  const product = f.db.prepare('SELECT * FROM products').get();
  f.worker.createJob(product, { ratio: '9:16', costCategory: 'test' }); f.worker.kick();
  await waitFor(() => f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='failed'").get().n === 1);
  assert.equal(calls, 1);
  const row = f.db.prepare('SELECT * FROM attempts').get();
  assert.equal(row.error_message, errorMessage);
  assert.equal(JSON.parse(row.error_raw).error.message, errorMessage);
  assert.equal((await post(f, `/api/attempts/${row.id}/retry`)).status, 202);
  assert.equal((await post(f, `/api/attempts/${row.id}/retry`)).status, 409);
  await waitFor(() => calls === 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM jobs').get().n, 2);
  assert.ok(f.db.prepare('SELECT cost_category FROM jobs').all().every(job => job.cost_category === 'test'));
});

test('expired membuat task baru, polling putus memakai task ID yang sama', async t => {
  for (const kind of ['expired', 'disconnect']) await t.test(kind, async t => {
    let posts = 0; let gets = 0;
    const f = await fixture(t, async (url, options) => {
      if (options.method === 'POST') return json({ id: `task-${++posts}` });
      if (url.startsWith('https://video.test')) return new Response('mp4');
      gets++;
      if (gets === 1) {
        if (kind === 'disconnect') throw new TypeError('Connection closed');
        return json({ status: 'expired', error: { message: 'Task expired.' } });
      }
      return json(successful);
    });
    f.worker.createJob(f.db.prepare('SELECT * FROM products').get(), { ratio: '16:9' }); f.worker.kick();
    await waitFor(() => f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='succeeded'").get().n === 1);
    assert.equal(posts, kind === 'expired' ? 2 : 1);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM attempts').get().n, 2);
  });
});

test('download gagal sementara diulang tanpa create baru dan tidak menyisakan file .part', async t => {
  let creates = 0; let downloads = 0;
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') { creates++; return json({ id: 'download-task' }); }
    if (url.startsWith('https://video.test')) return ++downloads === 1 ? new Response('temporary', { status: 503 }) : new Response('mp4');
    return json(successful);
  });
  f.worker.createJob(f.db.prepare('SELECT * FROM products').get(), { ratio: '16:9' }); f.worker.kick();
  await waitFor(() => f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='succeeded'").get().n === 1);
  assert.equal(creates, 1); assert.equal(downloads, 2);
  assert.deepEqual(await fs.readdir(f.config.videoDir), ['download-task.mp4']);
});

test('upload persis dua gambar menyimpan produk dan otomatis generate kedua format; validasi input', async t => {
  let creates = 0;
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') return json({ id: `upload-task-${++creates}` });
    if (url.startsWith('https://video.test')) return new Response('mp4');
    return json(successful);
  });
  const form = new FormData();
  form.set('name', 'Produk baru'); form.set('category', 'Kaos'); form.set('description', 'Cotton hitam');
  for (let i = 0; i < 2; i++) form.append('photos', new Blob([f.image], { type: 'image/png' }), `foto${i}.png`);
  const response = await f.request('/api/products', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  const data = await response.json();
  assert.equal(data.jobIds.length, 2);
  assert.match(data.product.photo1, /^upload-/);
  assert.deepEqual(await fs.readFile(path.join(f.config.photoDir, data.product.photo1)), f.image);
  await waitFor(() => f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='succeeded'").get().n === 2);
  const invalid = new FormData(); invalid.set('name', 'Test'); invalid.set('category', 'Test'); invalid.set('description', 'Test');
  for (let i = 0; i < 2; i++) invalid.append('photos', new Blob(['not an image'], { type: 'image/png' }), 'bad.png');
  assert.equal((await f.request('/api/products', { method: 'POST', body: invalid })).status, 400);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM products').get().n, 2);
  assert.equal((await post(f, '/api/products/1/generate', { ratio: '16:9', duration: 31 })).status, 400);
  assert.equal((await f.request('/api/generate-all', { method: 'POST', headers: { Origin: 'https://other.test' } })).status, 403);
});

test('prompt manual dipakai persis, file foto dibaca ulang setiap generate, dan seed sekali', async t => {
  const bodies = [];
  const f = await fixture(t, async (url, options) => {
    if (options.method === 'POST') { bodies.push(JSON.parse(options.body)); return json({ id: `custom-${bodies.length}` }); }
    if (url.startsWith('https://video.test')) return new Response('mp4');
    return json(successful);
  });
  const prompt = '  Prompt manual @Image1 @Image2 @Image3 tanpa orang dan teks tambahan.  ';
  const payload = { ratio: '9:16', duration: 12, prompt };
  assert.equal((await post(f, '/api/products/1/generate', payload)).status, 202);
  await waitFor(() => f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='succeeded'").get().n === 1);
  const updated = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#ff0000' } }).png().toBuffer();
  await fs.writeFile(path.join(f.config.photoDir, 'one.png'), updated);
  assert.equal((await post(f, '/api/products/1/generate', payload)).status, 202);
  await waitFor(() => bodies.length === 2);
  assert.equal(bodies[0].content[0].text, prompt);
  assert.equal(bodies[0].duration, 12);
  assert.notEqual(bodies[0].content[1].image_url.url, bodies[1].content[1].image_url.url);
  const reopened = openDatabase(f.config);
  assert.equal(reopened.prepare('SELECT COUNT(*) n FROM products').get().n, 1); reopened.close();
});

test('restart melanjutkan task yang sudah punya ID tanpa POST baru', async t => {
  let gets = 0;
  const f = await fixture(t, async (url, options) => {
    assert.notEqual(options.method, 'POST');
    if (url.startsWith('https://video.test')) return new Response('mp4');
    gets++; return json(successful);
  });
  const id = f.worker.createJob(f.db.prepare('SELECT * FROM products').get(), { ratio: '16:9' });
  f.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
  f.db.prepare(`INSERT INTO attempts (job_id,number,task_id,status,stage,started_at) VALUES (?,1,'existing-task','running','poll',?)`).run(id, new Date().toISOString());
  f.worker.kick();
  await waitFor(() => f.db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status === 'succeeded');
  assert.equal(gets, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM attempts').get().n, 1);
});

test('validasi dimensi foto dan key yang kosong tidak mencoba API', async t => {
  const tiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: 'white' } }).png().toBuffer();
  await assert.rejects(validateImage(tiny), /300–6000/);
  let calls = 0;
  const f = await fixture(t, async () => { calls++; }, { apiKey: '' });
  assert.equal((await post(f, '/api/generate-all')).status, 400);
  f.worker.createJob(f.db.prepare('SELECT * FROM products').get(), { ratio: '16:9' }); f.worker.kick();
  await waitFor(() => f.db.prepare("SELECT COUNT(*) n FROM jobs WHERE status='failed'").get().n === 1);
  assert.equal(calls, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM attempts').get().n, 1);
});

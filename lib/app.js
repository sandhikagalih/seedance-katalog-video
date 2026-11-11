import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateImage } from './seedance.js';
import { installAuth } from './auth.js';
import { buildCostReport, costReportCsv, COST_CATEGORIES } from './cost-report.js';

export function createApp(db, worker, config) {
  const app = express();
  app.disable('x-powered-by');
  // Blokir request mutasi lintas origin; aplikasi internal ini tidak memakai CORS.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob:; media-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'");
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin).host; } catch { return res.status(403).json({ error: 'Origin ditolak.' }); }
      if (origin !== req.headers.host) return res.status(403).json({ error: 'Origin ditolak.' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  installAuth(app, config);
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/foto-produk', express.static(config.photoDir, { dotfiles: 'deny', index: false }));
  app.use('/videos', express.static(config.videoDir, { dotfiles: 'deny', index: false }));
  app.use(express.static(path.join(config.root, 'public')));

  app.get('/api/state', (_req, res) => {
    const products = db.prepare('SELECT * FROM products ORDER BY id DESC').all();
    const tasks = db.prepare(`SELECT a.*,j.product_id,j.ratio,j.prompt,j.status AS job_status,j.next_run_at,
      p.name,p.category,p.photo1 FROM attempts a JOIN jobs j ON j.id=a.job_id
      JOIN products p ON p.id=j.product_id ORDER BY a.id DESC`).all();
    const jobs = db.prepare('SELECT id,product_id,ratio,status,next_run_at FROM jobs ORDER BY id DESC').all();
    res.json({ products, tasks, jobs, settings: { duration: config.duration, resolution: config.resolution,
      keyConfigured: Boolean(config.apiKey), pollSeconds: config.pollMs / 1000 } });
  });

  app.get('/api/cost-report', (_req, res) => res.json(buildCostReport(db, config)));
  app.get('/api/cost-report.csv', (_req, res) => {
    res.type('text/csv').attachment('laporan-biaya-hasil-tes.csv').send(costReportCsv(buildCostReport(db, config)));
  });
  app.patch('/api/jobs/:id/cost-category', (req, res) => {
    const { costCategory } = req.body || {};
    if (!COST_CATEGORIES.includes(costCategory)) return res.status(400).json({ error: 'Kategori harus product, test, atau revision.' });
    const result = db.prepare('UPDATE jobs SET cost_category=? WHERE id=?').run(costCategory, req.params.id);
    if (!result.changes) return res.status(404).json({ error: 'Job tidak ditemukan.' });
    res.json({ ok: true });
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: {
    fileSize: 30 * 1024 * 1024 - 1, files: 2, fields: 3, fieldSize: 12000,
  } }).array('photos', 2);

  app.post('/api/products', upload, async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const category = typeof req.body.category === 'string' ? req.body.category.trim() : '';
    const description = typeof req.body.description === 'string' ? req.body.description.trim() : '';
    if (!name || !category || !description || name.length > 160 || category.length > 80 || description.length > 6000) {
      return res.status(400).json({ error: 'Isi nama (maks. 160), kategori (maks. 80), dan deskripsi (maks. 6000 karakter).' });
    }
    if (req.files?.length !== 2) return res.status(400).json({ error: 'Upload tepat 2 foto produk.' });
    const formats = await Promise.all(req.files.map(f => validateImage(f.buffer)));
    const saved = [];
    let product;
    try {
      for (let i = 0; i < 2; i++) {
        const filename = `upload-${randomUUID()}.${formats[i]}`;
        await fs.writeFile(path.join(config.photoDir, filename), req.files[i].buffer, { flag: 'wx' });
        saved.push(filename);
      }
      const result = db.prepare(`INSERT INTO products (slug,name,category,description,photo1,photo2,created_at) VALUES (?,?,?,?,?,?,?)`)
        .run(`produk-${randomUUID()}`, name, category, description, ...saved, new Date().toISOString());
      product = db.prepare('SELECT * FROM products WHERE id=?').get(result.lastInsertRowid);
    } catch (error) {
      await Promise.all(saved.map(file => fs.rm(path.join(config.photoDir, file), { force: true })));
      throw error;
    }
    const jobIds = worker.generateMissing(product.id);
    res.status(201).json({ product, jobIds });
  });

  app.post('/api/generate-all', (_req, res) => {
    if (!config.apiKey) return res.status(400).json({ error: 'Isi ARK_API_KEY di .env lalu mulai ulang server.' });
    const jobIds = worker.generateMissing();
    res.status(202).json({ jobIds, message: `${jobIds.length} video dimasukkan ke antrian.` });
  });

  app.post('/api/products/:id/generate', (req, res) => {
    if (!config.apiKey) return res.status(400).json({ error: 'Isi ARK_API_KEY di .env lalu mulai ulang server.' });
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
    if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan.' });
    const { ratio, duration, prompt = '', costCategory = 'revision' } = req.body || {};
    if (!COST_CATEGORIES.includes(costCategory)) return res.status(400).json({ error: 'Kategori biaya tidak valid.' });
    if (!['16:9', '9:16'].includes(ratio) || !Number.isInteger(duration) || duration < 4 || duration > 30 || typeof prompt !== 'string' || prompt.length > 12000) {
      return res.status(400).json({ error: 'Format harus 16:9 / 9:16, durasi bilangan bulat 4–30 detik, prompt maks. 12000 karakter.' });
    }
    const id = worker.createJob(product, { ratio, duration, prompt, costCategory });
    worker.kick();
    res.status(202).json({ jobId: id });
  });

  app.post('/api/attempts/:id/retry', (req, res) => {
    if (!config.apiKey) return res.status(400).json({ error: 'Isi ARK_API_KEY di .env lalu mulai ulang server.' });
    const attempt = db.prepare('SELECT * FROM attempts WHERE id=?').get(req.params.id);
    if (!attempt) return res.status(404).json({ error: 'Percobaan tidak ditemukan.' });
    const job = db.prepare('SELECT * FROM jobs WHERE id=?').get(attempt.job_id);
    if (job.status !== 'failed') return res.status(409).json({ error: 'Task masih berjalan, menunggu retry otomatis, atau sudah selesai.' });
    const product = db.prepare('SELECT * FROM products WHERE id=?').get(job.product_id);
    // Riwayat job lama tetap utuh. Retry manual mendapat jatah baru 1 + 2 retry.
    const newId = worker.createJob(product, { ratio: job.ratio, duration: job.duration, prompt: job.prompt, costCategory: job.cost_category });
    db.prepare('UPDATE jobs SET resolution=? WHERE id=?').run(job.resolution, newId);
    // Cegah klik ganda pada baris yang sama.
    db.prepare("UPDATE jobs SET status='retried' WHERE id=?").run(job.id);
    worker.kick();
    res.status(202).json({ jobId: newId });
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint tidak ditemukan.' }));
  app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError || error.name === 'TaskError' || error.type === 'entity.parse.failed' || error.status === 413) {
      return res.status(400).json({ error: error.message });
    }
    // Jangan bocorkan stack / konfigurasi server.
    res.status(500).json({ error: 'Terjadi kesalahan penyimpanan/server. Periksa izin folder dan ruang disk.' });
  });
  return app;
}

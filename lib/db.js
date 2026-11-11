import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(config) {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  fs.mkdirSync(config.videoDir, { recursive: true });
  fs.mkdirSync(config.photoDir, { recursive: true });
  const db = new DatabaseSync(config.dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY, slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, category TEXT NOT NULL, description TEXT NOT NULL,
      photo1 TEXT NOT NULL, photo2 TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),
      ratio TEXT NOT NULL, duration INTEGER NOT NULL, resolution TEXT NOT NULL,
      prompt TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
      created_at TEXT NOT NULL, next_run_at TEXT
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id),
      number INTEGER NOT NULL, task_id TEXT, status TEXT NOT NULL DEFAULT 'queued',
      stage TEXT NOT NULL DEFAULT 'create', started_at TEXT NOT NULL, finished_at TEXT,
      duration REAL, resolution TEXT, completion_tokens INTEGER,
      error_message TEXT, error_code TEXT, error_raw TEXT, video_file TEXT,
      UNIQUE(job_id, number)
    );
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS jobs_product ON jobs(product_id, ratio, status);
  `);
  // Migrasi aditif: riwayat lama tetap utuh dan bisa dikategorikan dari laporan.
  if (!db.prepare('PRAGMA table_info(jobs)').all().some(column => column.name === 'cost_category')) {
    db.exec("ALTER TABLE jobs ADD COLUMN cost_category TEXT NOT NULL DEFAULT 'product' CHECK(cost_category IN ('product','test','revision'))");
  }
  if (!db.prepare("SELECT 1 FROM metadata WHERE key = 'seeded'").get()) {
    const file = path.join(config.photoDir, 'katalog.json');
    if (fs.existsSync(file)) {
      const products = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      db.exec('BEGIN');
      try {
        const insert = db.prepare('INSERT OR IGNORE INTO products (slug,name,category,description,photo1,photo2,created_at) VALUES (?,?,?,?,?,?,?)');
        for (const p of products) {
          if (!p.slug || !p.nama || !p.kategori || !p.deskripsi || p.foto?.length !== 2 || p.foto.some(f => path.basename(f) !== f)) {
            throw new Error('Format foto-produk/katalog.json tidak valid.');
          }
          insert.run(p.slug, p.nama, p.kategori, p.deskripsi, ...p.foto, new Date().toISOString());
        }
        db.prepare("INSERT INTO metadata VALUES ('seeded', '1')").run();
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  }
  return db;
}

import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Seedance, TaskError, buildPrompt } from './seedance.js';

const now = () => new Date().toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Worker {
  constructor(db, config, fetchFn = fetch) {
    this.db = db;
    this.config = config;
    this.api = new Seedance(config, fetchFn);
    this.fetch = fetchFn;
    this.running = new Map();
    this.stopping = false;
  }

  createJob(product, { ratio, duration = this.config.duration, prompt = '', costCategory = 'product' }) {
    const result = this.db.prepare(`INSERT INTO jobs
      (product_id,ratio,duration,resolution,prompt,created_at,cost_category) VALUES (?,?,?,?,?,?,?)`)
      .run(product.id, ratio, duration, this.config.resolution, prompt.trim() ? prompt : buildPrompt(product), now(), costCategory);
    return Number(result.lastInsertRowid);
  }

  generateMissing(productId = null) {
    const products = productId ? this.db.prepare('SELECT * FROM products WHERE id=?').all(productId)
      : this.db.prepare('SELECT * FROM products').all();
    const ids = [];
    // Tidak ada await selama pemeriksaan + insert: klik berulang tidak menduplikasi task aktif.
    for (const product of products) for (const ratio of ['16:9', '9:16']) {
      const existing = this.db.prepare(`SELECT id FROM jobs WHERE product_id=? AND ratio=?
        AND status IN ('queued','running','succeeded') LIMIT 1`).get(product.id, ratio);
      if (!existing) ids.push(this.createJob(product, { ratio }));
    }
    this.kick();
    return ids;
  }

  kick() {
    if (this.stopping) return;
    const jobs = this.db.prepare("SELECT id FROM jobs WHERE status IN ('queued','running')").all();
    for (const { id } of jobs) {
      if (this.running.has(id)) continue;
      // Semua job diluncurkan tanpa menunggu job lainnya selesai.
      const promise = Promise.resolve().then(() => this.run(id)).catch(() => {
        // Kesalahan SQLite / disk tidak boleh menjadi unhandled rejection.
        console.error(`Worker job ${id} berhenti karena kesalahan penyimpanan. Mulai ulang server untuk melanjutkan.`);
      }).finally(() => this.running.delete(id));
      this.running.set(id, promise);
    }
  }

  async pause(ms) {
    // Shutdown tidak harus menunggu timer 10/15 detik habis.
    const until = Date.now() + ms;
    while (!this.stopping && Date.now() < until) await sleep(Math.min(200, until - Date.now()));
  }

  async run(id) {
    const job = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    const product = this.db.prepare('SELECT * FROM products WHERE id=?').get(job.product_id);
    let attempt = this.db.prepare('SELECT * FROM attempts WHERE job_id=? ORDER BY number DESC LIMIT 1').get(id);
    while (!this.stopping) {
      if (job.next_run_at) {
        await this.pause(Math.max(0, Date.parse(job.next_run_at) - Date.now()));
        if (this.stopping) return;
        job.next_run_at = null;
        this.db.prepare('UPDATE jobs SET next_run_at=NULL WHERE id=?').run(id);
      }
      if (!attempt || attempt.status === 'failed') {
        // Retry polling/download memakai ID yang sama; expired membuat task baru.
        const taskId = attempt && attempt.error_code !== 'expired' ? attempt.task_id : null;
        const number = (attempt?.number || 0) + 1;
        const inserted = this.db.prepare(`INSERT INTO attempts
          (job_id,number,task_id,status,stage,started_at,duration,resolution) VALUES (?,?,?,'queued',?,?,?,?)`)
          .run(id, number, taskId, taskId ? 'poll' : 'create', now(), job.duration, job.resolution);
        attempt = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(inserted.lastInsertRowid);
      }
      try {
        this.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);
        if (!attempt.task_id) {
          const taskId = await this.api.create(job, product);
          this.db.prepare("UPDATE attempts SET task_id=?, stage='poll' WHERE id=?").run(taskId, attempt.id);
          attempt.task_id = taskId;
        }
        while (!this.stopping) {
          const result = await this.api.retrieve(attempt.task_id);
          const tokens = result.usage?.completion_tokens ?? null;
          this.db.prepare('UPDATE attempts SET duration=?,resolution=?,completion_tokens=COALESCE(?,completion_tokens) WHERE id=?')
            .run(result.duration ?? job.duration, result.resolution ?? job.resolution, tokens, attempt.id);
          if (['failed', 'expired', 'cancelled'].includes(result.status)) {
            const code = result.error?.code || result.status;
            const temporary = result.status === 'expired' || /^(InternalError|InternalServerError|ServiceUnavailable|TooManyRequests|RequestTimeout)(\.|$)/i.test(code);
            throw new TaskError(result.error?.message ?? result.status, {
              code, raw: JSON.stringify(result), retryable: temporary, expired: result.status === 'expired',
            });
          }
          if (result.status === 'succeeded') {
            this.db.prepare("UPDATE attempts SET status='running',stage='download' WHERE id=?").run(attempt.id);
            if (!result.content?.video_url) throw new TaskError('API sukses tetapi content.video_url tidak tersedia.');
            const filename = `${attempt.task_id}.mp4`;
            await this.download(result.content.video_url, filename);
            this.db.exec('BEGIN');
            try {
              this.db.prepare("UPDATE attempts SET status='succeeded',video_file=?,finished_at=? WHERE id=?").run(filename, now(), attempt.id);
              this.db.prepare("UPDATE jobs SET status='succeeded',next_run_at=NULL WHERE id=?").run(id);
              this.db.exec('COMMIT');
            } catch (error) { this.db.exec('ROLLBACK'); throw error; }
            return;
          }
          if (!['queued', 'running'].includes(result.status)) throw new TaskError(`Status API tidak dikenal: ${result.status}`);
          this.db.prepare('UPDATE attempts SET status=? WHERE id=?').run(result.status, attempt.id);
          await this.pause(this.config.pollMs);
        }
        return;
      } catch (error) {
        const retry = error.retryable === true && attempt.number < 3;
        const retryAt = retry ? new Date(Date.now() + this.config.retryMs).toISOString() : null;
        this.db.exec('BEGIN');
        try {
          this.db.prepare(`UPDATE attempts SET status='failed',finished_at=?,error_message=?,error_code=?,error_raw=? WHERE id=?`)
            .run(now(), error.message, error.expired ? 'expired' : (error.code || ''), error.raw ?? null, attempt.id);
          this.db.prepare('UPDATE jobs SET status=?,next_run_at=? WHERE id=?').run(retry ? 'queued' : 'failed', retryAt, id);
          this.db.exec('COMMIT');
        } catch (dbError) { this.db.exec('ROLLBACK'); throw dbError; }
        if (!retry) return;
        attempt = this.db.prepare('SELECT * FROM attempts WHERE id=?').get(attempt.id);
        job.next_run_at = retryAt;
      }
    }
  }

  async download(url, filename) {
    const target = path.join(this.config.videoDir, filename);
    const temp = `${target}.part`;
    try {
      const response = await this.fetch(url, { signal: AbortSignal.timeout(this.config.downloadTimeoutMs) });
      if (!response.ok) throw new TaskError(await response.text(), {
        retryable: response.status === 429 || response.status >= 500,
        code: String(response.status),
      });
      if (!response.body) throw new TaskError('Respons download video kosong.', { retryable: true });
      await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));
      const stat = await fs.stat(temp);
      if (!stat.size) throw new TaskError('File video kosong.', { retryable: true });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      if (error instanceof TaskError) throw error;
      const localDiskError = ['ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'EROFS'].includes(error.code);
      throw new TaskError(error.message, { retryable: !localDiskError, code: error.code || error.name });
    }
  }

  async stop() {
    this.stopping = true;
    await Promise.allSettled(this.running.values());
  }
}

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export class TaskError extends Error {
  constructor(message, { retryable = false, code = '', raw = null, expired = false } = {}) {
    super(message);
    this.name = 'TaskError';
    Object.assign(this, { retryable, code, raw, expired });
  }
}

export function buildPrompt(product) {
  return `Buat video promosi produk e-commerce WPU Store dalam Bahasa Indonesia. Produk: ${product.name}. Kategori: ${product.category}. Deskripsi: ${product.description}. Gunakan @Image1 dan @Image2 sebagai referensi dua tampilan produk yang sama; pertahankan bentuk, bahan, warna, motif, dan detail aslinya. Tampilkan logo WPU Store dari @Image3 dalam ukuran kecil di pojok bawah dengan jarak aman dari tepi. Pertahankan bentuk dan warna logo aslinya. Logo harus berada di area kosong dan tidak boleh menutupi produk atau detail produk sepanjang video; produk tetap menjadi fokus utama. Tampilkan produk saja dengan gerakan kamera halus, pencahayaan studio profesional, latar bersih bernuansa teal, detail bahan dan pengambilan gambar menyeluruh. Tanpa orang, wajah, tangan, model manusia, atau manekin. Tanpa teks tambahan, judul, caption, subtitle, atau tulisan overlay selain logo kecil @Image3 di pojok bawah; pertahankan motif dan logo asli pada produk. Audio aktif berupa musik instrumental yang sesuai, tanpa narasi atau percakapan.`;
}

export async function validateImage(buffer) {
  if (buffer.length >= 30 * 1024 * 1024) throw new TaskError('Foto harus berukuran kurang dari 30 MB.');
  let info;
  try { info = await sharp(buffer, { limitInputPixels: 36_000_000 }).metadata(); }
  catch { throw new TaskError('Foto tidak valid. Gunakan JPEG, PNG, atau WebP.'); }
  if (!['jpeg', 'png', 'webp'].includes(info.format) || info.pages > 1) throw new TaskError('Gunakan foto JPEG, PNG, atau WebP statis.');
  const { width, height } = info;
  if (width < 300 || height < 300 || width > 6000 || height > 6000 || width / height < 0.4 || width / height > 2.5) {
    throw new TaskError('Sisi foto harus 300–6000 px dan rasio lebar/tinggi 0.4–2.5.');
  }
  return info.format;
}

export class Seedance {
  constructor(config, fetchFn = fetch) {
    this.config = config;
    this.fetch = fetchFn;
    this.pollSlot = 0;
  }

  async request(endpoint, options = {}) {
    if (!this.config.apiKey) throw new TaskError('ARK_API_KEY belum diisi di file .env server.');
    let response;
    try {
      response = await this.fetch(`${this.config.baseUrl}/contents/generations/tasks${endpoint}`, {
        ...options,
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
    } catch (error) {
      throw new TaskError(error.message, { retryable: true, code: error.name });
    }
    const raw = await response.text().catch(error => {
      throw new TaskError(error.message, { retryable: true, code: error.name });
    });
    let data;
    try { data = JSON.parse(raw); }
    catch { data = null; }
    if (!response.ok) {
      throw new TaskError(data?.error?.message ?? raw, {
        retryable: response.status === 429 || response.status >= 500,
        code: data?.error?.code || String(response.status), raw,
      });
    }
    if (!data) throw new TaskError('Respons API bukan JSON valid.', { retryable: true, raw });
    return data;
  }

  async create(job, product) {
    // Selalu baca kembali ketiga file, termasuk saat membuat task retry.
    const content = [{ type: 'text', text: job.prompt }];
    for (const filename of [product.photo1, product.photo2, 'logo-wpustore-teal.png']) {
      let bytes;
      try { bytes = await fs.readFile(path.join(this.config.photoDir, filename)); }
      catch { throw new TaskError(`Foto referensi tidak dapat dibaca: ${filename}`); }
      const format = await validateImage(bytes);
      content.push({ type: 'image_url', image_url: { url: `data:image/${format};base64,${bytes.toString('base64')}` }, role: 'reference_image' });
    }
    const body = JSON.stringify({ model: this.config.model, content, ratio: job.ratio,
      duration: job.duration, resolution: job.resolution, generate_audio: true, watermark: false });
    if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new TaskError('Body request melebihi batas 64 MB.');
    const result = await this.request('', { method: 'POST', body });
    if (!/^[a-zA-Z0-9_-]+$/.test(result.id || '')) throw new TaskError('API tidak mengembalikan task ID yang valid.');
    return result.id;
  }

  async retrieve(id) {
    // Batas global <20 GET/detik; POST create tetap dikirim bersamaan.
    const now = Date.now();
    const slot = Math.max(now, this.pollSlot);
    this.pollSlot = slot + 55;
    if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now));
    return this.request(`/${encodeURIComponent(id)}`);
  }
}

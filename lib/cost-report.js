const PRICE = 6.40;
export const COST_CATEGORIES = ['product', 'test', 'revision'];
const labels = { product: 'Video yang jadi', test: 'Tes', failed: 'Percobaan gagal/retry', revision: 'Revisi', pending: 'Masih diproses' };

export function buildCostReport(db, config) {
  const attempts = db.prepare(`SELECT a.*, j.product_id, j.ratio, j.cost_category,
    j.duration AS requested_duration, j.resolution AS requested_resolution, p.name
    FROM attempts a JOIN jobs j ON j.id=a.job_id JOIN products p ON p.id=j.product_id
    ORDER BY a.id`).all();
  // usage adalah kumulatif per task API, bukan biaya baru tiap polling/download retry.
  const tasks = new Map();
  for (const attempt of attempts) {
    const key = attempt.task_id ? `task:${attempt.task_id}` : `attempt:${attempt.id}`;
    const previous = tasks.get(key);
    const observed = Number.isFinite(attempt.completion_tokens) && attempt.completion_tokens >= 0 ? attempt.completion_tokens : null;
    tasks.set(key, { ...attempt,
      completion_tokens: observed === null ? previous?.completion_tokens ?? null : Math.max(observed, previous?.completion_tokens ?? 0),
      attemptIds: [...(previous?.attemptIds || []), attempt.id],
    });
  }
  const kurs = Number.isFinite(config.kursUsdIdr) && config.kursUsdIdr > 0 ? config.kursUsdIdr : null;
  const groups = Object.entries(labels).map(([category, label]) => ({ category, label, tasks: 0, completionTokens: 0, packageTokens: 0, missingTokens: 0 }));
  const rows = [...tasks.values()].map(task => {
    const completed = task.status === 'succeeded' && Boolean(task.video_file);
    // Kategori saling eksklusif; kegagalan didahulukan, retry sukses mengikuti tujuan job.
    const category = task.status === 'failed' ? 'failed'
      : !completed ? 'pending' : task.cost_category;
    const resolution = task.resolution ?? task.requested_resolution;
    const ratio = resolution === '1080p' ? 1.828125 : ['480p', '720p'].includes(resolution) ? 1.671875 : null;
    const packageTokens = task.completion_tokens === null || ratio === null ? null : task.completion_tokens * ratio;
    const usd = packageTokens === null ? null : packageTokens / 1_000_000 * PRICE;
    return { jobId: task.job_id, taskId: task.task_id, attemptIds: task.attemptIds,
      product: task.name, costCategory: task.cost_category, category, status: task.status,
      completed, duration: task.duration ?? task.requested_duration, resolution, aspectRatio: task.ratio,
      completionTokens: task.completion_tokens, conversionRatio: ratio, packageTokens, usd,
      idr: usd === null || kurs === null ? null : usd * kurs };
  });
  for (const row of rows) {
    const group = groups.find(group => group.category === row.category);
    group.tasks++;
    group.completionTokens += row.completionTokens ?? 0;
    group.packageTokens += row.packageTokens ?? 0;
    if (row.completionTokens === null) group.missingTokens++;
  }
  for (const group of groups) {
    group.usd = group.packageTokens / 1_000_000 * PRICE;
    group.idr = kurs === null ? null : group.usd * kurs;
  }
  const completionTokens = groups.reduce((sum, group) => sum + group.completionTokens, 0);
  const packageTokens = groups.reduce((sum, group) => sum + group.packageTokens, 0);
  const usd = packageTokens / 1_000_000 * PRICE;
  // Semua output produk/revisi yang tersimpan; video tes tidak menjadi pembagi modal.
  const videos = rows.filter(row => row.completed && row.costCategory !== 'test');
  const specs = new Map();
  for (const video of videos) {
    const key = `${video.duration}/${video.resolution}`;
    const spec = specs.get(key) || { duration: video.duration, resolution: video.resolution, count: 0, totalDuration: 0 };
    spec.count++;
    spec.totalDuration += video.duration;
    specs.set(key, spec);
  }
  return { label: 'HASIL TES', pricePerMillion: PRICE, kursUsdIdr: kurs, groups, rows,
    videoSpecs: [...specs.values()], totals: { completedVideos: videos.length,
      totalDuration: videos.reduce((sum, row) => sum + row.duration, 0), completionTokens, packageTokens,
      usd, idr: kurs === null ? null : usd * kurs,
      averageUsd: videos.length ? usd / videos.length : null,
      averageIdr: videos.length && kurs !== null ? usd * kurs / videos.length : null,
      missingTokens: rows.filter(row => row.completionTokens === null).length,
      unknownResolution: rows.filter(row => row.conversionRatio === null).length } };
}

// Kutip setiap sel dan cegah formula injection ketika CSV dibuka di spreadsheet.
const cell = value => {
  const text = value == null ? '' : String(value);
  return `"${(/^[\s]*[=+@-]/.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
};
export function costReportCsv(report) {
  const table = [
    ['HASIL TES'],
    ['Metrik', 'Nilai'],
    ['Harga USD per 1 juta token paket', report.pricePerMillion],
    ['KURS_USD_IDR', report.kursUsdIdr],
    ['Video produk jadi (termasuk revisi, tanpa tes)', report.totals.completedVideos],
    ['Total durasi video produk (detik)', report.totals.totalDuration],
    ['Total completion_tokens', report.totals.completionTokens],
    ['Estimasi token paket', report.totals.packageTokens],
    ['Estimasi total USD', report.totals.usd], ['Estimasi total IDR', report.totals.idr],
    ['Rata-rata modal USD/video', report.totals.averageUsd], ['Rata-rata modal IDR/video', report.totals.averageIdr],
    ['Task tanpa data token (bukan berarti gratis)', report.totals.missingTokens],
    ['Task dengan resolusi tidak dikenal', report.totals.unknownResolution],
    [], ['Kategori', 'Jumlah task', 'completion_tokens', 'Estimasi token paket', 'Estimasi USD', 'Estimasi IDR', 'Task tanpa data token'],
    ...report.groups.map(group => [group.label, group.tasks, group.completionTokens, group.packageTokens, group.usd, group.idr, group.missingTokens]),
    [], ['Durasi video produk (detik)', 'Resolusi', 'Jumlah video', 'Total detik'],
    ...report.videoSpecs.map(spec => [spec.duration, spec.resolution, spec.count, spec.totalDuration]),
    [], ['Job ID', 'Task ID', 'Attempt ID', 'Produk', 'Tujuan job', 'Kategori biaya', 'Status', 'Durasi', 'Resolusi', 'Format', 'completion_tokens', 'Rasio paket', 'Estimasi token paket', 'Estimasi USD', 'Estimasi IDR'],
    ...report.rows.map(row => [row.jobId, row.taskId, row.attemptIds.join(' / '), row.product, row.costCategory, labels[row.category], row.status, row.duration, row.resolution, row.aspectRatio, row.completionTokens, row.conversionRatio, row.packageTokens, row.usd, row.idr]),
    [], ['Catatan', 'Estimasi berdasarkan token tercatat; task ID yang sama dihitung sekali. Gagal masuk gagal/retry; retry sukses mengikuti tujuan job. Input aplikasi berupa teks/gambar. Riwayat lama dianggap Produk sampai ditandai ulang.'],
  ];
  return '\uFEFF' + table.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

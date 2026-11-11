const $ = selector => document.querySelector(selector);
let state = { products: [], tasks: [], jobs: [], settings: {} };
let activeTab = 'catalog';
let toastTimer;
let refreshPending = false;
let previousSignature = '';
let reportPending = false;
const labels = { queued: 'Antri', running: 'Jalan', succeeded: 'Selesai', failed: 'Gagal', missing: 'Belum ada' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const photoUrl = filename => `/foto-produk/${encodeURIComponent(filename)}`;
const videoUrl = filename => `/videos/${encodeURIComponent(filename)}`;
const badge = status => `<span class="status ${escape(status)}">${escape(labels[status] || status)}</span>`;

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').classList.toggle('error', error);
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6000);
}

async function api(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 401) {
    location.replace('/login');
    throw new Error('Session berakhir. Silakan login lagi.');
  }
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result;
}

function post(url, data) {
  return api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data || {}) });
}

$('#logout').addEventListener('click', async () => {
  try { await post('/api/logout'); location.replace('/login'); }
  catch (error) { toast(error.message, true); }
});

function switchTab(tab) {
  activeTab = tab;
  $('.page').classList.toggle('task-page', tab === 'tasks');
  $('#catalog-panel').hidden = tab !== 'catalog';
  $('#tasks-panel').hidden = tab !== 'tasks';
  $('#costs-panel').hidden = tab !== 'costs';
  $('.stats').hidden = tab === 'costs';
  $('.heading-actions').hidden = tab === 'costs';
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $('#page-title').textContent = tab === 'costs' ? 'Laporan biaya' : tab === 'catalog' ? 'Dari produk, jadi cerita.' : 'Setiap proses, terlihat.';
  $('#page-description').textContent = tab === 'costs' ? 'Lihat pemakaian token dan modal setiap video produk.' : tab === 'catalog' ? 'Kelola katalog dan buat video produk dalam satu tempat.' : 'Pantau antrian, hasil video, dan riwayat setiap percobaan.';
  $('#breadcrumb').textContent = tab === 'costs' ? 'Laporan biaya' : tab === 'catalog' ? 'Katalog produk' : 'Dashboard task';
  history.replaceState(null, '', tab === 'catalog' ? '#katalog' : `#${tab}`);
  if (tab === 'costs') refreshCostReport();
}

const number = value => value === null ? 'Belum tersedia' : Number(value).toLocaleString('id-ID', { maximumFractionDigits: 4 });
const money = (value, currency) => value === null ? 'Belum tersedia' : Number(value).toLocaleString('id-ID', {
  style: 'currency', currency, minimumFractionDigits: currency === 'USD' ? 4 : 2, maximumFractionDigits: currency === 'USD' ? 4 : 2,
});
async function refreshCostReport(force = false) {
  if (reportPending) return;
  reportPending = true;
  try {
    const report = await api('/api/cost-report');
    const total = report.totals;
    $('#cost-error').textContent = '';
    $('#cost-kurs').textContent = report.kursUsdIdr === null ? 'Kurs belum diisi' : `Kurs Rp ${number(report.kursUsdIdr)}/USD`;
    $('#cost-summary').innerHTML = [
      ['Video produk jadi', number(total.completedVideos), `${number(total.totalDuration)} detik total`],
      ['Total completion_tokens', number(total.completionTokens), `${number(total.packageTokens)} estimasi token paket`],
      ['Estimasi seluruh biaya', money(total.usd, 'USD'), money(total.idr, 'IDR')],
      ['Rata-rata modal / video', money(total.averageUsd, 'USD'), money(total.averageIdr, 'IDR')],
    ].map(([label, value, detail]) => `<div class="stat"><span>${escape(label)}</span><strong>${escape(value)}</strong><small>${escape(detail)}</small></div>`).join('');
    const warnings = [];
    if (report.kursUsdIdr === null) warnings.push('Isi KURS_USD_IDR di .env lalu restart server untuk melihat rupiah.');
    if (!total.completedVideos) warnings.push('Belum ada video produk jadi; rata-rata modal belum tersedia.');
    if (total.missingTokens) warnings.push(`${number(total.missingTokens)} task/percobaan belum memiliki data token. Total biaya hanya mencakup token yang tercatat, sehingga estimasi dapat lebih rendah dari biaya sebenarnya.`);
    if (total.unknownResolution) warnings.push(`${number(total.unknownResolution)} task memiliki resolusi tidak dikenal; estimasi token paketnya belum dihitung.`);
    $('#cost-warning').hidden = !warnings.length;
    $('#cost-warning').textContent = warnings.join(' ');
    $('#cost-groups').innerHTML = report.groups.map(group => `<tr><td>${escape(group.label)}</td><td>${number(group.tasks)}</td><td>${number(group.completionTokens)}</td><td>${number(group.packageTokens)}</td><td>${money(group.usd, 'USD')}</td><td>${money(group.idr, 'IDR')}</td></tr>`).join('')
      + `<tr class="cost-total"><td>Total</td><td>${number(report.rows.length)}</td><td>${number(total.completionTokens)}</td><td>${number(total.packageTokens)}</td><td>${money(total.usd, 'USD')}</td><td>${money(total.idr, 'IDR')}</td></tr>`;
    $('#cost-specs').innerHTML = report.videoSpecs.map(spec => `<tr><td>${number(spec.duration)} detik</td><td>${escape(spec.resolution)}</td><td>${number(spec.count)}</td><td>${number(spec.totalDuration)} detik</td></tr>`).join('') || '<tr><td colspan="4">Belum ada video produk yang jadi.</td></tr>';
    // Jangan mengganti select yang sedang dipakai ketika polling memperbarui laporan.
    if (force || !$('#cost-rows').contains(document.activeElement)) {
      const categoryLabels = Object.fromEntries(report.groups.map(group => [group.category, group.label]));
      $('#cost-rows').innerHTML = report.rows.map(row => `<tr><td>${escape(row.product)}<br>Job #${row.jobId}</td><td>${escape(row.taskId || 'Belum ada task ID')}<br><small>Attempt: ${escape(row.attemptIds.join(', '))}</small></td><td><select data-cost-job="${row.jobId}" aria-label="Kategori biaya job ${row.jobId}">${[['product', 'Produk'], ['test', 'Tes'], ['revision', 'Revisi']].map(([value, label]) => `<option value="${value}" ${row.costCategory === value ? 'selected' : ''}>${label}</option>`).join('')}</select></td><td>${escape(categoryLabels[row.category])}</td><td>${badge(row.status)}</td><td>${number(row.duration)} detik / ${escape(row.resolution)}<br>${escape(row.aspectRatio)}</td><td>${number(row.completionTokens)}</td><td>${number(row.conversionRatio)}</td><td>${money(row.usd, 'USD')}</td></tr>`).join('') || '<tr><td colspan="9">Belum ada percobaan generate.</td></tr>';
    }
  } catch (error) { $('#cost-error').textContent = `Laporan gagal diperbarui: ${error.message}`; }
  finally { reportPending = false; }
}

$('#cost-rows').addEventListener('change', async event => {
  const select = event.target.closest('[data-cost-job]');
  if (!select) return;
  select.disabled = true;
  try {
    await api(`/api/jobs/${select.dataset.costJob}/cost-category`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ costCategory: select.value }) });
    toast('Kategori biaya disimpan.');
  } catch (error) { toast(error.message, true); }
  finally { select.disabled = false; await refreshCostReport(true); }
});

function renderSummary() {
  const active = state.jobs.filter(j => ['queued', 'running'].includes(j.status)).length;
  const failed = state.jobs.filter(j => j.status === 'failed').length;
  $('#stat-products').textContent = state.products.length;
  $('#stat-videos').textContent = state.tasks.filter(t => t.status === 'succeeded').length;
  $('#stat-active').textContent = active;
  $('#stat-failed').textContent = failed;
  $('#nav-count').textContent = state.products.length;
  $('#active-count').textContent = active;
  $('#key-warning').hidden = state.settings.keyConfigured;
  $('#defaults').textContent = `${state.settings.duration} detik / ${state.settings.resolution}`;
  const categories = [...new Set(state.products.map(p => p.category))].sort();
  const filter = $('#category-filter');
  const selected = filter.value;
  filter.innerHTML = '<option value="">Semua kategori</option>' + categories.map(c => `<option value="${escape(c)}">${escape(c)}</option>`).join('');
  filter.value = selected;
  $('#category-options').innerHTML = categories.map(c => `<option value="${escape(c)}"></option>`).join('');
}

function renderCatalog() {
  const search = $('#search').value.toLocaleLowerCase('id');
  const category = $('#category-filter').value;
  const products = state.products.filter(p => (!category || p.category === category) && `${p.name} ${p.description} ${p.category}`.toLocaleLowerCase('id').includes(search));
  $('#catalog-count').textContent = `${products.length} produk`;
  $('#product-grid').innerHTML = products.length ? products.map(product => {
    const completed = state.tasks.filter(t => t.product_id === product.id && t.status === 'succeeded');
    const formats = ['16:9', '9:16'].map(ratio => {
      const video = completed.find(t => t.ratio === ratio);
      const job = state.jobs.find(j => j.product_id === product.id && j.ratio === ratio);
      let status = video ? 'succeeded' : job?.status || 'missing';
      if (status === 'retried') status = 'failed';
      if (['queued', 'running'].includes(job?.status)) status = job.status;
      return `<div class="format-row"><span class="format-label"><strong>${ratio === '16:9' ? '▱' : '▯'} ${ratio}</strong> ${ratio === '16:9' ? 'Halaman toko' : 'Media sosial'}</span><span>${badge(status)} ${video ? `<button class="video-link" data-video="${video.id}">Lihat ↗</button>` : ''}</span></div>`;
    }).join('');
    return `<article class="product-card"><div class="product-image"><img src="${photoUrl(product.photo1)}" alt="${escape(product.name)}" loading="lazy"><span class="category-tag">${escape(product.category)}</span></div><div class="product-info"><h3>${escape(product.name)}</h3><p class="product-description" title="${escape(product.description)}">${escape(product.description)}</p><div class="product-formats">${formats}</div><button class="button secondary version-button" data-version="${product.id}">✧ Generate versi lain</button>${completed.length ? `<details class="version-history"><summary>Semua versi video (${completed.length})</summary>${completed.map(v => `<button class="video-link" data-video="${v.id}">${escape(v.ratio)} · ${escape(v.duration)} dtk · ${escape(v.resolution)} · ${escape(formatTime(v.finished_at))}</button>`).join('')}</details>` : ''}</div></article>`;
  }).join('') : '<div class="empty">Tidak ada produk yang cocok. Tambahkan produk atau ubah pencarian.</div>';
}

function formatTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return `${date.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' })}\n${date.toLocaleTimeString('id-ID', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

function renderTasks() {
  const filter = $('#status-filter').value;
  const tasks = state.tasks.filter(t => !filter || t.status === filter);
  $('#task-rows').innerHTML = tasks.length ? tasks.map(taskRow).join('')
    : '<tr><td colspan="11" class="empty">Belum ada task untuk ditampilkan.</td></tr>';
}

function taskRow(task) {
  let action = '—';
  if (task.video_file) {
    action = `<button class="video-link" data-video="${task.id}">Lihat video ↗</button><br>
      <a class="video-link" href="${videoUrl(task.video_file)}" download>Download</a>`;
  } else if (task.status === 'failed') {
    // Tetap tampilkan aksi di setiap baris gagal. Cegah tabrakan dengan retry otomatis.
    const canRetry = task.job_status === 'failed';
    const reason = task.next_run_at ? 'Menunggu retry otomatis'
      : task.job_status === 'succeeded' ? 'Sudah berhasil pada percobaan berikutnya'
      : task.job_status === 'retried' ? 'Sudah dijalankan ulang'
      : 'Task masih berjalan';
    action = `<button class="button secondary" data-retry="${task.id}"
      ${canRetry ? '' : `disabled title="${reason}"`}>Jalanin ulang</button>`;
  }
  const tokens = task.completion_tokens == null ? '—' : Number(task.completion_tokens).toLocaleString('id-ID');
  const retryNote = task.next_run_at ? `<span class="retry-note">Retry otomatis: ${escape(formatTime(task.next_run_at))}</span>` : '';
  const errorText = [task.error_message, task.error_code].filter(Boolean).join('\n') || '—';
  return `<tr>
    <td><div class="task-product"><img src="${photoUrl(task.photo1)}" alt="">
      <div><strong>${escape(task.name)}</strong><small>${escape(task.category)}</small></div></div></td>
    <td>${escape(task.ratio)}</td>
    <td><span class="task-id" title="${escape(task.task_id || '')}">${escape(task.task_id || 'Belum ada task ID')}</span></td>
    <td>${badge(task.status)}${retryNote}</td>
    <td class="time">${escape(formatTime(task.started_at))}</td>
    <td class="time">${escape(formatTime(task.finished_at))}</td>
    <td>${task.number} / 3</td>
    <td>${escape(task.duration)} dtk<br>${escape(task.resolution)}</td>
    <td>${tokens}</td>
    <td class="error-cell"><div class="error-preview" title="${escape(errorText)}" tabindex="0">${escape(errorText)}</div></td>
    <td>${action}</td>
  </tr>`;
}

async function refresh() {
  if (refreshPending) return;
  refreshPending = true;
  try {
    const next = await api('/api/state');
    const signature = JSON.stringify(next);
    state = next;
    // Jangan mereset video/detail/fokus jika data belum berubah.
    if (signature !== previousSignature) {
      renderSummary(); renderCatalog(); renderTasks();
      previousSignature = signature;
    }
    $('#sync-status').textContent = `Diperbarui ${new Date().toLocaleTimeString('id-ID', { hour12: false })} · otomatis tiap 3 dtk`;
    if (activeTab === 'costs') await refreshCostReport();
  } catch (error) { $('#sync-status').textContent = `Koneksi terputus · ${error.message} · mencoba lagi…`; }
  finally { refreshPending = false; }
}

document.querySelectorAll('[data-tab]').forEach(button => button.addEventListener('click', () => switchTab(button.dataset.tab)));
$('#search').addEventListener('input', renderCatalog);
$('#category-filter').addEventListener('change', renderCatalog);
$('#status-filter').addEventListener('change', renderTasks);
$('#add-product').addEventListener('click', () => $('#product-dialog').showModal());
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
$('#video-dialog').addEventListener('close', () => { $('#video-player').pause(); $('#video-player').removeAttribute('src'); $('#video-player').load(); });
let previews = [];
$('#photos').addEventListener('change', event => {
  previews.forEach(URL.revokeObjectURL);
  previews = [...event.target.files].slice(0, 2).map(file => URL.createObjectURL(file));
  $('#photo-previews').innerHTML = previews.map(url => `<img src="${url}" alt="Pratinjau foto produk">`).join('');
  event.target.setCustomValidity(event.target.files.length === 2 ? '' : 'Pilih tepat 2 foto.');
});

$('#generate-all').addEventListener('click', async event => {
  const button = event.currentTarget;
  button.disabled = true;
  try { const result = await post('/api/generate-all'); toast(result.message); await refresh(); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

$('#product-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('[type=submit]');
  form.querySelector('.form-error').textContent = '';
  button.disabled = true;
  try {
    await api('/api/products', { method: 'POST', body: new FormData(form) });
    form.reset(); $('#photos').setCustomValidity(''); $('#photo-previews').replaceChildren();
    previews.forEach(URL.revokeObjectURL); previews = [];
    $('#product-dialog').close(); toast('Produk disimpan. Dua video mulai diproses.'); await refresh();
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#version-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const button = form.querySelector('[type=submit]');
  form.querySelector('.form-error').textContent = '';
  button.disabled = true;
  try {
    await post(`/api/products/${data.get('productId')}/generate`, { ratio: data.get('ratio'), duration: Number(data.get('duration')), prompt: data.get('prompt'), costCategory: data.get('costCategory') });
    $('#version-dialog').close(); toast('Versi video baru mulai diproses.'); await refresh();
  } catch (error) { form.querySelector('.form-error').textContent = error.message; }
  finally { button.disabled = false; }
});

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-version], [data-video], [data-retry]');
  if (!button) return;
  if (button.dataset.version) {
    const product = state.products.find(p => p.id === Number(button.dataset.version));
    const form = $('#version-form'); form.reset();
    form.elements.productId.value = product.id;
    form.elements.duration.value = state.settings.duration;
    form.querySelector('.form-error').textContent = '';
    $('#version-product').textContent = `${product.name} · ${state.settings.resolution}`;
    $('#version-dialog').showModal();
  }
  if (button.dataset.video) {
    const task = state.tasks.find(t => t.id === Number(button.dataset.video));
    $('#video-title').textContent = `${task.name} · ${task.ratio}`;
    $('#video-player').src = videoUrl(task.video_file);
    $('#video-download').href = videoUrl(task.video_file);
    $('#video-dialog').showModal();
  }
  if (button.dataset.retry) {
    button.disabled = true;
    try { await post(`/api/attempts/${button.dataset.retry}/retry`); toast('Task dijalankan ulang dengan referensi foto terbaru.'); await refresh(); }
    catch (error) { toast(error.message, true); button.disabled = false; }
  }
});

switchTab(['#tasks', '#costs'].includes(location.hash) ? location.hash.slice(1) : activeTab);
refresh();
setInterval(refresh, 3000);

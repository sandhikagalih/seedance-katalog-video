# WPU Store — Video Studio

👉 Get your Seedance 2.5 API Key on BytePlus: https://bit.ly/4B3FJiP

Source code dari video WPU tentang otomatisasi video produk pakai **Seedance 2.5 API**: tiap produk baru di katalog langsung dibikinin video 16:9 & 9:16, lengkap sama nomor task, status, dan laporan biaya. Link video: [YOUTUBE_LINK]. Prompt yang dipakai di video: https://gist.github.com/sandhikagalih/48e5c131101ba621ccae67d9c58f6a98

Tool internal untuk katalog produk dan pembuatan video melalui Seedance 2.5 BytePlus. Dibuat dengan Node.js, Express, SQLite bawaan Node, dan HTML/CSS/JavaScript biasa.

**Foto contoh:** `foto-produk/` berisi Hoodie WPU Navy & Kaos WPU Hitam (otomatis masuk katalog dari `katalog.json`) plus logo WPU Store. `contoh-produk-baru/` berisi 2 foto Hoodie WPU Abu-abu buat dicoba lewat form **Tambah produk**. Ganti semuanya pakai foto & logo produk kalian.

## Menjalankan di Windows / PowerShell

Gunakan **Node.js 22.14 atau lebih baru**. Dari folder proyek:

```powershell
npm install
Copy-Item .env.example .env
```

Buka `.env`, lalu isi akun tim dan key akun BytePlus di server:

```dotenv
ARK_API_KEY=isi_key_BytePlus_Anda_di_sini
ADMIN_EMAIL=email_tim_Anda
ADMIN_PASSWORD=password_tim_Anda
SESSION_COOKIE_SECURE=false
KURS_USD_IDR=16000
ARK_BASE_URL=https://ark.ap-southeast.bytepluses.com/api/v3
ARK_MODEL=dreamina-seedance-2-5-260628
VIDEO_DURATION=5
VIDEO_RESOLUTION=480p
PORT=3000
HOST=127.0.0.1
```

Jangan menimpa `.env` jika file itu sudah ada. Key hanya dibaca dari file ini oleh server. `.env` diabaikan Git; `.env.example` tidak berisi key asli. Jangan memasukkan key ke HTML, JavaScript browser, atau prompt. Mulai ulang server setelah mengubah `.env`.

```powershell
npm start
```

Buka **http://127.0.0.1:3000**. Hentikan dengan `Ctrl+C`. Mode pengembangan: `npm run dev`. Node 22 dapat menampilkan peringatan bahwa `node:sqlite` masih eksperimental; ini bukan kegagalan server.

Secara default server hanya menerima koneksi dari komputer ini. Untuk penggunaan melalui LAN, ubah `HOST=0.0.0.0`, lalu buka `http://IP-komputer-server:3000`. Jalankan satu proses server untuk satu database.

Semua anggota tim memakai satu akun dari `ADMIN_EMAIL` dan `ADMIN_PASSWORD` di `.env`. Buka aplikasi lalu login; konfigurasi kosong membuat akses tetap terkunci. Semua halaman aplikasi, API katalog/upload/generate/retry, foto, dan video memerlukan login. Halaman login serta CSS/JavaScript login tersedia sebelum masuk. Tombol **Keluar** mencabut session browser tersebut.

Session disimpan dalam memori server dengan token acak pada cookie `httpOnly`, `SameSite=Strict`, berlaku 12 jam. Restart server mengakhiri seluruh session; perubahan kredensial memerlukan restart. Untuk akses melalui HTTPS, termasuk reverse proxy, set `SESSION_COOKIE_SECURE=true` agar cookie hanya dikirim melalui HTTPS. Gunakan HTTPS saat diakses di luar komputer lokal agar kredensial dan cookie terlindungi selama transmisi.

## Cara memakai

1. Saat pertama dijalankan, server mengimpor `foto-produk/katalog.json` ke `data/katalog.sqlite` sekali. Produk awal tidak langsung memakai kuota API.
2. Klik **Generate semua** untuk membuat format yang belum ada: 16:9 dan 9:16. Format yang sudah selesai atau masih berjalan dilewati. Format gagal dapat dijalankan lagi dari dashboard atau lewat Generate semua.
3. **Tambah produk**: isi nama, kategori, deskripsi, lalu pilih tepat dua foto. Produk disimpan dan dua video otomatis dimulai. Jika key belum diisi, produk tetap tersimpan dan percobaan ditandai gagal dengan penjelasan konfigurasi.
4. **Generate versi lain**: pilih format, durasi 4–30 detik, dan prompt opsional. Prompt manual yang tidak kosong dikirim persis seperti diisi. Sebut `@Image1` dan `@Image2` untuk produk serta `@Image3` untuk logo; sertakan arahan tanpa orang dan tanpa teks tambahan. Jika kosong, prompt Bahasa Indonesia dibentuk dari nama, deskripsi, dan kategori produk.
5. **Dashboard task** menampilkan satu baris per percobaan, task ID, status, waktu sampai detik, durasi/resolusi, `usage.completion_tokens`, pesan error asli API, serta link hasil. Dashboard dan katalog mengambil data baru tiap 3 detik; server mengecek status API setiap 10 detik per task.
6. Video yang selesai tersedia melalui **Lihat**, **Download**, dan **Semua versi video** di kartu produk. Hasil disimpan ke `videos/<task_id>.mp4` sebelum task ditandai selesai.
7. Tombol **Jalanin ulang** muncul jika job akhirnya gagal. Percobaan lama tetap tersimpan; retry manual membuat job baru dengan format, durasi, resolusi, dan prompt yang sama serta jatah retry baru.

## Laporan biaya — HASIL TES

Buka **Laporan biaya** pada navigasi. Laporan dan **Export CSV** mengambil data SQLite yang sama dan memerlukan login. Isi `KURS_USD_IDR` di `.env` dengan kurs rupiah per USD pilihan tim lalu restart server. Angka `16000` di contoh hanya contoh konfigurasi, bukan kurs terkini. Jika kosong, laporan dolar tetap tersedia dan rupiah ditandai belum tersedia.

Laporan menghitung seluruh riwayat: jumlah video produk/revisi yang selesai dan tersimpan (tanpa video tes), rincian durasi/resolusi, token per kategori, estimasi token paket, total biaya dan rata-rata modal. Rumus input teks/gambar mengikuti `CATATAN-API-SEEDANCE.md`: `completion_tokens × 1.671875` untuk 480p/720p, atau `× 1.828125` untuk 1080p. Estimasi dolar = token paket × $6.40 / 1.000.000; rupiah = dolar × kurs. Rata-rata modal memakai seluruh biaya tercatat, termasuk tes/gagal/revisi, dibagi jumlah video produk jadi; bila belum ada output, rata-rata belum tersedia.

Generate semua dan upload baru berkategori **Produk**. Generate versi lain menyediakan pilihan **Produk / Tes / Revisi**, dengan default Revisi. Kategori riwayat dapat diubah pada rincian laporan dan tersimpan per job; retry manual mewarisinya. Data lama dianggap Produk hingga ditandai ulang oleh tim. Kategori token saling eksklusif: task gagal masuk **Percobaan gagal/retry**, task yang belum selesai masuk **Masih diproses**, dan task sukses mengikuti tujuan job. Retry sukses tetap dihitung sebagai output sesuai tujuan job.

Task ID yang sama pada retry polling/download dihitung sekali menggunakan nilai `completion_tokens` kumulatif terbesar yang tercatat. Task baru, termasuk retry setelah expired, dihitung terpisah. Token kosong bukan nol atau gratis: laporan menampilkan jumlah task yang datanya belum tersedia. Biaya hanya mengestimasi token yang tersimpan, bukan tagihan resmi atau rekonsiliasi akun BytePlus. Rasio editing tidak digunakan karena aplikasi ini hanya mengirim teks/gambar. CSV memuat ringkasan, kategori, spesifikasi video, dan rincian task; token yang tidak tersedia dibiarkan kosong.

## Aturan gambar dan request

- Dua foto produk dan `foto-produk/logo-wpustore-teal.png` selalu dibaca ulang saat membuat task API, termasuk retry create. Mengganti file akan memengaruhi generate berikutnya. Tidak ada cache Base64.
- Tiga gambar dikirim berurutan sebagai `reference_image` dalam data URL Base64, sesuai `CATATAN-API-SEEDANCE.md`.
- JPEG, PNG, atau WebP statis; setiap sisi 300–6000 px; rasio lebar/tinggi 0.4–2.5; masing-masing kurang dari 30 MB. Total body API maksimal 64 MB. Gunakan foto produk tanpa wajah orang asli.
- Semua job create diluncurkan bersamaan, tidak menunggu video lain selesai. Batas task berjalan mengikuti akun BytePlus; API bisa menempatkan sisanya dalam antrian.
- GET status diberi jarak global minimal 55 ms agar berada di bawah batas 20 request/detik. Banyak task dapat membuat interval efektif polling lebih panjang dari 10 detik.
- Audio selalu aktif dan watermark selalu mati. Durasi default 5 detik dan resolusi default 480p; resolusi `.env` mendukung 480p, 720p, dan 1080p.

## Retry dan pemulihan

HTTP 429, 5xx, timeout, koneksi putus, status `expired`, dan kode error server sementara yang dikenali dicoba ulang maksimal **2 kali** setelah percobaan pertama, dengan jeda **15 detik**. Maksimal tiga baris percobaan per job. Error input, autentikasi, dan izin tidak dicoba ulang otomatis. `error.message` API disimpan dan ditampilkan tanpa perubahan; kode dan respons error mentah juga disimpan di SQLite.

Gangguan polling atau download memakai task ID yang sudah ada. Status expired membuat task baru. Download menggunakan file `.part`, lalu menggantinya menjadi `.mp4` hanya setelah transfer selesai. Task berstatus selesai hanya setelah file tersimpan dan terhubung ke produk.

Job, task ID, jadwal retry, dan hasil disimpan di SQLite. Setelah restart, server melanjutkan job yang masih antri/jalan. Jangan menjalankan beberapa proses server pada database yang sama. Bila koneksi terputus saat **POST create** sebelum ID diterima, API mungkin sudah menerima task; retry POST berpotensi membuat task tambahan karena catatan API tidak menyediakan idempotency key. Riwayat lokal mencatat task ID yang berhasil diterima.

## Struktur kode

```text
server.js             Menjalankan Express dan melanjutkan worker
lib/config.js         Membaca .env dan default
lib/db.js             Skema SQLite dan impor katalog sekali
lib/seedance.js       Prompt, validasi gambar, dan request BytePlus
lib/worker.js         Create paralel, polling, retry, download
lib/app.js            Endpoint katalog, upload, generate, dan retry
public/               Antarmuka HTML + CSS + JavaScript biasa
test/app.test.js      Tes integrasi dengan API tiruan
foto-produk/          Katalog awal, dua foto/produk, logo, upload
data/katalog.sqlite   Database otomatis dibuat, diabaikan Git
videos/               Hasil video lokal, diabaikan Git
```

Endpoint utama: `GET /api/state`, `POST /api/products` (multipart field `photos` dua file), `POST /api/generate-all`, `POST /api/products/:id/generate`, `POST /api/attempts/:id/retry`.

Untuk backup, hentikan server lalu salin `data/`, `foto-produk/`, dan `videos/` bersama-sama. Foto upload dan video diabaikan Git karena merupakan data runtime.

## Pengujian

```powershell
npm test
```

Tes memakai database/foto sementara dan API tiruan, tanpa key asli dan tanpa kuota BytePlus. Cakupannya meliputi create paralel, format payload Base64, upload, retry dan jedanya, error input tanpa retry, polling/download tanpa create tambahan, expired, prompt manual, pembacaan ulang foto, pemulihan restart, dan perlindungan key.

Integrasi mengikuti kontrak dalam `CATATAN-API-SEEDANCE.md`. Kualitas video serta akses model pada akun Anda perlu dicek lewat generate nyata setelah key diisi.

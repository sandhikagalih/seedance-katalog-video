# Catatan API Seedance 2.5 (BytePlus ModelArk)

Sumber: docs.byteplus.com/en/docs/modelark (Create / Retrieve / List video generation task, Dreamina Seedance 2.5 tutorial). Dicek 10 Nov 2026.

- Base URL: https://ark.ap-southeast.bytepluses.com/api/v3
- Auth: header `Authorization: Bearer <ARK_API_KEY>`
- Model ID: `dreamina-seedance-2-5-260628`

## Bikin task (async)

POST /contents/generations/tasks

```json
{
  "model": "dreamina-seedance-2-5-260628",
  "content": [
    { "type": "text", "text": "prompt ... @Image1 ... @Image2 ..." },
    { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,...." }, "role": "reference_image" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,...." }, "role": "reference_image" }
  ],
  "resolution": "480p",
  "ratio": "9:16",
  "duration": 5,
  "generate_audio": true,
  "watermark": false
}
```

- resolution: 480p | 720p | 1080p
- ratio: 16:9 | 4:3 | 1:1 | 3:4 | 9:16 | 21:9 | adaptive
- duration: 4–30 detik, atau -1 (model yang milih). Default -1, jadi selalu diisi.
- Respons sukses: `{ "id": "cgt-..." }`
- Gambar ke-1 dipanggil `@Image1` di prompt, ke-2 `@Image2`, dst.

## Cek task

GET /contents/generations/tasks/{id}

- status: queued | running | succeeded | failed | expired | cancelled
- sukses: `content.video_url` cuma berlaku 24 jam dan maks 100x download. Langsung download.
- `usage.completion_tokens`, `usage.total_tokens`
- gagal: `error.code`, `error.message`
- `created_at`, `updated_at` (Unix detik), `resolution`, `ratio`, `duration`

## Daftar task (buat cocokin task ID)

GET /contents/generations/tasks?filter.task_ids=ID1&filter.task_ids=ID2 (maks 1 request/detik)

## Batasan

- Reference image: 1–30 gambar, jpeg/png/webp, sisi 300–6000 px, rasio lebar/tinggi 0.4–2.5, < 30 MB. Body request maks 64 MB.
- Foto berisi wajah orang asli ditolak.
- reference_image nggak boleh dicampur first_frame / last_frame.
- Akun individu maks 3 task jalan barengan (sisanya queued), akun enterprise 10. Maks 180 / 600 request per menit, lewat dari itu HTTP 429.
- Cek status maks 20 request/detik.
- Task ID berlaku 7 hari.

## Edit video (local editing)

Endpoint sama, bedanya:

- content: text (prompt wajib ada kata edit / ganti / hapus / tambah, sebut `@Video1`) + `{ "type": "video_url", "video_url": { "url": "<URL publik video>" }, "role": "reference_video" }`
- Video sumber 4–30 detik, harus URL publik (bukan Base64). Boleh pakai `content.video_url` asli dari task sebelumnya selama belum lewat 24 jam.
- `"omni_reference_task_type": "edit"`, `"ratio": "adaptive"`, `"duration": -1`

## Potongan kuota resource pack

Input tanpa video (teks/gambar): 480p/720p → 1 token = 1.671875 token paket, 1080p → 1.828125.
Ada input video (editing): 480p/720p → 1:1, 1080p → 1.09375.

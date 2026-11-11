import { config } from './lib/config.js';
import { openDatabase } from './lib/db.js';
import { Worker } from './lib/worker.js';
import { createApp } from './lib/app.js';

const db = openDatabase(config);
const worker = new Worker(db, config);
const app = createApp(db, worker, config);
const server = app.listen(config.port, config.host, () => {
  console.log(`WPU Store Video Studio: http://${config.host}:${config.port}`);
  if (!config.apiKey) console.log('Isi ARK_API_KEY di .env dan mulai ulang server untuk membuat video.');
  worker.kick(); // Lanjutkan task tertunda dari SQLite setelah restart.
});
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await worker.stop();
  db.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

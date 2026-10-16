// Initiates the single-node replica set on the throwaway mongod (run.sh calls this until it succeeds).
import { MongoClient } from 'mongodb';
const port = process.env.E2E_MONGO_PORT || '27281';
const c = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true`, { serverSelectionTimeoutMS: 3000 });
try {
  await c.connect();
  try { await c.db('admin').command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } }); } catch (e) { if (!/already initialized/i.test(e.message)) throw e; }
  for (let i = 0; i < 40; i++) {
    const h = await c.db('admin').command({ hello: 1 });
    if (h.isWritablePrimary) { console.log('primary ready'); await c.close(); process.exit(0); }
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('no primary');
} catch (e) { console.error(e.message); await c.close().catch(() => {}); process.exit(1); }

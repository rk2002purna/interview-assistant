const { newDb } = require('pg-mem');
const db = newDb();
db.public.none(`CREATE TABLE re(user_id uuid NOT NULL, ts timestamptz NOT NULL, kind text NOT NULL, ip inet NULL, PRIMARY KEY(user_id, ts, kind))`);
const u = '11111111-1111-4111-8111-111111111111';
db.public.none(`INSERT INTO re(user_id, ts, kind) VALUES ('${u}', now() - interval '5 seconds', 'ai_op'),('${u}', now() - interval '15 seconds', 'ai_op'),('${u}', now() - interval '90 seconds', 'ai_op')`);
console.log('inserted');

(async () => {
  const adapters = db.adapters.createPg();
  const pool = new adapters.Pool();
  const c = await pool.connect();
  try {
    const r = await c.query(`SELECT count(*)::int AS c, MIN(ts) AS oldest FROM re WHERE user_id=$1 AND kind=$2 AND ts > $3::timestamptz`,
      [u, 'ai_op', new Date(Date.now()-60_000).toISOString()]);
    console.log('windowed:', JSON.stringify(r.rows));
    const r2 = await c.query(`SELECT count(*) FILTER (WHERE ts > $3::timestamptz)::int AS c1, MIN(ts) FILTER (WHERE ts > $3::timestamptz) AS o1, count(*) FILTER (WHERE ts > $4::timestamptz)::int AS c2, MIN(ts) FILTER (WHERE ts > $4::timestamptz) AS o2 FROM re WHERE user_id=$1 AND kind=$2 AND ts > $4::timestamptz`,
      [u, 'ai_op', new Date(Date.now()-60_000).toISOString(), new Date(Date.now()-86_400_000).toISOString()]);
    console.log('filter:', JSON.stringify(r2.rows));
    const r3 = await c.query(`INSERT INTO re(user_id, ts, kind, ip) VALUES ($1, $2::timestamptz, $3, $4) RETURNING ts`,
      [u, new Date().toISOString(), 'ai_op', '127.0.0.1']);
    console.log('inserted2:', JSON.stringify(r3.rows));
  } catch (e) {
    console.log('err:', e.message);
  } finally {
    c.release();
    await pool.end();
  }
})();

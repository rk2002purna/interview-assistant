import { newDb } from 'pg-mem';
const db = newDb();
try {
  db.public.none(`CREATE TABLE t (a int, ts timestamptz, PRIMARY KEY(a, ts))`);
  const at = new Date('2025-01-01T12:00:00Z').toISOString();
  db.public.none(`INSERT INTO t VALUES (1, '${new Date('2025-01-01T11:59:55Z').toISOString()}')`);
  db.public.none(`INSERT INTO t VALUES (2, '${new Date('2025-01-01T11:58:50Z').toISOString()}')`);
  // Try interval cast and parameterized
  const r1 = db.public.many(`SELECT count(*)::bigint AS c, MIN(ts) AS m FROM t WHERE ts > '${at}'::timestamptz - interval '60 seconds'`);
  console.log('within60', JSON.stringify(r1));
  // make_interval
  const r2 = db.public.many(`SELECT count(*)::bigint AS c FROM t WHERE ts > '${at}'::timestamptz - make_interval(secs => 60)`);
  console.log('make_interval', JSON.stringify(r2));
  // Use seconds expression: ($1 || ' seconds')::interval
  const r3 = db.public.many(`SELECT count(*) AS c FROM t WHERE ts > '${at}'::timestamptz - (60 || ' seconds')::interval`);
  console.log('cast_interval', JSON.stringify(r3));
  // Adapter style with placeholders
  const adapters = db.adapters.createPg();
  const pool = new adapters.Pool();
  const client = await pool.connect();
  const r4 = await client.query(`SELECT count(*)::bigint AS c, MIN(ts) AS m FROM t WHERE user_id IS NULL OR true`).catch(e=>({err:e.message}));
  console.log('adapter ok?', JSON.stringify(r4.rows ?? r4));
  // Real query
  const r5 = await client.query(
    `SELECT count(*)::bigint AS c, MIN(ts) AS m FROM t WHERE ts > $1::timestamptz - ($2 || ' seconds')::interval`,
    [at, 60],
  ).catch(e => ({err: e.message}));
  console.log('param_query', JSON.stringify(r5.rows ?? r5));
  client.release();
  await pool.end();
} catch (e) {
  console.error('ERR', e.message);
}

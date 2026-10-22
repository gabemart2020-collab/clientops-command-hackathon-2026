import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

export async function runSeed(
  pool: Pool,
  seedFilePath = resolve(process.cwd(), 'supabase/seed.sql'),
): Promise<void> {
  const sql = readFileSync(seedFilePath, 'utf8');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

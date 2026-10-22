import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';

export async function runMigrations(
  pool: Pool,
  migrationsDir = resolve(process.cwd(), 'supabase/migrations'),
): Promise<string[]> {
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Create migrations tracker table if not exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS _schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    for (const file of files) {
      const alreadyApplied = await client.query(
        'SELECT version FROM _schema_migrations WHERE version = $1',
        [file],
      );
      if (alreadyApplied.rows.length === 0) {
        const sql = readFileSync(resolve(migrationsDir, file), 'utf8');
        await client.query(sql);
        await client.query(
          'INSERT INTO _schema_migrations (version) VALUES ($1)',
          [file],
        );
        applied.push(file);
      }
    }

    await client.query('COMMIT');
    return applied;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

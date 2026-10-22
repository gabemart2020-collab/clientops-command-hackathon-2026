import { execSync } from 'node:child_process';
import {
  getDatabasePool,
  closeDatabasePool,
  runMigrations,
  runSeed,
} from '../packages/data/src/index.js';

const CONTAINER_NAME = 'clientops-postgres';
const PORT = '5432';
const DB_NAME = 'clientops_dev';
const PASSWORD = 'postgres';
const IMAGE = 'postgres:16-alpine';

function isContainerRunning(): boolean {
  try {
    const stdout = execSync(
      `docker ps --filter "name=${CONTAINER_NAME}" --filter "status=running" --format "{{.Names}}"`,
      { encoding: 'utf8' },
    ).trim();
    return stdout === CONTAINER_NAME;
  } catch {
    return false;
  }
}

function containerExists(): boolean {
  try {
    const stdout = execSync(
      `docker ps -a --filter "name=${CONTAINER_NAME}" --format "{{.Names}}"`,
      { encoding: 'utf8' },
    ).trim();
    return stdout === CONTAINER_NAME;
  } catch {
    return false;
  }
}

async function waitForPostgres(maxRetries = 20, delayMs = 500): Promise<void> {
  const pool = getDatabasePool();
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await pool.query('SELECT 1');
      if (res.rows.length > 0) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    'Timed out waiting for PostgreSQL container to become ready.',
  );
}

async function startContainer(): Promise<void> {
  if (isContainerRunning()) {
    console.log(
      `Container ${CONTAINER_NAME} is already running on port ${PORT}.`,
    );
    return;
  }

  if (containerExists()) {
    console.log(`Starting existing container ${CONTAINER_NAME}...`);
    execSync(`docker start ${CONTAINER_NAME}`);
  } else {
    console.log(
      `Creating and starting container ${CONTAINER_NAME} on port ${PORT}...`,
    );
    execSync(
      `docker run -d --name ${CONTAINER_NAME} -p ${PORT}:5432 -e POSTGRES_PASSWORD=${PASSWORD} -e POSTGRES_DB=${DB_NAME} ${IMAGE}`,
    );
  }

  console.log('Waiting for PostgreSQL to be ready...');
  await waitForPostgres();
  console.log('PostgreSQL is ready.');
}

function stopContainer(): void {
  if (isContainerRunning()) {
    console.log(`Stopping container ${CONTAINER_NAME}...`);
    execSync(`docker stop ${CONTAINER_NAME}`);
    console.log(`Container ${CONTAINER_NAME} stopped.`);
  } else {
    console.log(`Container ${CONTAINER_NAME} is not running.`);
  }
}

async function resetDatabase(): Promise<void> {
  const pool = getDatabasePool();
  console.log('Running migrations from supabase/migrations/...');
  const applied = await runMigrations(pool);
  console.log(
    `Migrations applied: ${applied.length > 0 ? applied.join(', ') : 'All migrations already applied.'}`,
  );
}

async function demoReset(): Promise<void> {
  const pool = getDatabasePool();
  console.log(
    'Resetting schema and applying seed data from supabase/seed.sql...',
  );
  await runMigrations(pool);
  await runSeed(pool);
  console.log(
    'Deterministic demo dataset restored successfully (Acme Labs + BetaCorp).',
  );
}

async function main() {
  const command = process.argv[2];

  try {
    switch (command) {
      case 'start':
        await startContainer();
        break;
      case 'stop':
        stopContainer();
        break;
      case 'reset':
        await startContainer();
        await resetDatabase();
        break;
      case 'demo-reset':
        await startContainer();
        await demoReset();
        break;
      default:
        console.error('Usage: tsx scripts/db.ts [start|stop|reset|demo-reset]');
        process.exit(1);
    }
  } catch (error) {
    console.error('Database command error:', error);
    process.exit(1);
  } finally {
    await closeDatabasePool();
  }
}

void main();

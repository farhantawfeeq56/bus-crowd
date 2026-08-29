import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

// Creates the database if needed, then applies db/schema.sql from scratch.
const url = process.env.DATABASE_URL ?? 'postgresql://localhost:5432/busmesh';
const dbName = new URL(url).pathname.slice(1);
const adminUrl = url.replace(`/${dbName}`, '/postgres');

const admin = new Client({ connectionString: adminUrl });
await admin.connect();
const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (!rowCount) {
  await admin.query(`CREATE DATABASE ${dbName}`);
  console.log(`created database ${dbName}`);
}
await admin.end();

const client = new Client({ connectionString: url });
await client.connect();
await client.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await client.end();
console.log('schema applied');

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { Client } from '@neondatabase/serverless';

// Applies db/schema.sql from scratch. This repo's database lives on Neon:
// databases are created with the `neon` CLI / console, never CREATE DATABASE.
const url =
  process.env.DATABASE_URL ?? (() => { throw new Error('DATABASE_URL is not set — see .env'); })();

const client = new Client(url);
await client.connect();
await client.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
await client.end();
console.log('schema applied');
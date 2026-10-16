// session-store.js — where partner and customer login sessions are kept.
//
//   memory   → inside the server's memory, exactly like the local PoC. On
//              AgentCore each conversation gets its own server copy, so this is
//              fine for demos, but sessions vanish when that copy is stopped.
//   dynamodb → an Amazon DynamoDB table (production). Sessions survive restarts
//              and expire automatically via DynamoDB "time to live" (TTL).
//
// Table layout (created by scripts/p2-create-session-table.sh):
//   pk        (string, partition key)  e.g. "session#sess_ab12…"
//   value     (string)                 the session record as JSON
//   expiresAt (number)                 Unix time in seconds; DynamoDB's TTL
//                                      deletes the item some time after this
import { createMemoryStore } from '../../../server/bpi-mcp-server.js';

export async function createSessionStore(settings, log) {
  if (settings.sessionStore === 'memory') {
    log({ level: 'info', text: 'Session store: memory (demo).' });
    return createMemoryStore();
  }

  const { DynamoDBClient, GetItemCommand, PutItemCommand } = await import('@aws-sdk/client-dynamodb');
  const db = new DynamoDBClient({ region: settings.region });
  const TableName = settings.sessionTableName;
  log({ level: 'info', text: `Session store: DynamoDB table "${TableName}".` });
  return createDynamoStore({ db, TableName, GetItemCommand, PutItemCommand });
}

// Kept separate so it can be tested without AWS (pass a fake `db`).
export function createDynamoStore({ db, TableName, GetItemCommand, PutItemCommand, now = () => Date.now() }) {
  const DEFAULT_TTL = 3600; // seconds, used when a caller gives no TTL
  return {
    async get(kind, key) {
      if (!key) return undefined;
      const out = await db.send(new GetItemCommand({ TableName, Key: { pk: { S: `${kind}#${key}` } }, ConsistentRead: true }));
      if (!out.Item) return undefined;
      // TTL deletion can lag, so double-check the expiry ourselves.
      if (Number(out.Item.expiresAt?.N || 0) * 1000 <= now()) return undefined;
      return JSON.parse(out.Item.value.S);
    },
    async set(kind, key, value, ttlSeconds) {
      const expiresAt = Math.floor(now() / 1000) + Number(ttlSeconds || DEFAULT_TTL);
      await db.send(new PutItemCommand({
        TableName,
        Item: { pk: { S: `${kind}#${key}` }, value: { S: JSON.stringify(value) }, expiresAt: { N: String(expiresAt) } },
      }));
    },
  };
}

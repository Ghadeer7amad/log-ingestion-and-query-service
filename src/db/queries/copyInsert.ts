import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { copyPool } from '../index.js';
import { InsertBatch } from './logs.js';
import { yieldToEventLoop } from '../../utils/yieldToEventLoop.js';

export async function insertLogsCopy(batch: InsertBatch): Promise<number> {
  const rowCount = batch.timestamps.length;
  if (rowCount === 0) return 0;

  const copyText = await buildCopyText(batch);

  const client = await copyPool.connect();

  let clientError: Error | null = null;
  let onClientError: (err: Error) => void = () => {};
  const clientErrorPromise = new Promise<never>((_, reject) => {
    onClientError = (err: Error) => {
      clientError = err;
      reject(err);
    };
    client.once('error', onClientError);
  });

  try {
    const copyStream = client.query(
      copyFrom(`COPY logs (timestamp, level, service, message, attributes) FROM STDIN WITH (FORMAT text)`)
    );
    const source = Readable.from([copyText]);

    await Promise.race([pipeline(source, copyStream), clientErrorPromise]);
    if (clientError) throw clientError;

    client.removeListener('error', onClientError);
    client.release();
    return rowCount;
  } catch (err) {
    client.removeListener('error', onClientError);
    const error = err instanceof Error ? err : new Error(String(err));
    client.release(error);
    throw error;
  }
}

const NEEDS_ESCAPE = /[\\\t\n\r]/;

function escapeCopyField(value: string): string {
  if (!NEEDS_ESCAPE.test(value)) return value;
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

const YIELD_CHUNK_ROWS = 500;

export async function buildCopyText(batch: InsertBatch): Promise<string> {
  const rowCount = batch.timestamps.length;
  const rows = new Array<string>(rowCount);
  for (let i = 0; i < rowCount; i++) {
    rows[i] =
      escapeCopyField(batch.timestamps[i]) +
      '\t' +
      escapeCopyField(batch.levels[i]) +
      '\t' +
      escapeCopyField(batch.services[i]) +
      '\t' +
      escapeCopyField(batch.messages[i]) +
      '\t' +
      escapeCopyField(batch.attributesJson[i]);

    if ((i + 1) % YIELD_CHUNK_ROWS === 0) {
      await yieldToEventLoop();
    }
  }
  return rows.join('\n') + '\n';
}

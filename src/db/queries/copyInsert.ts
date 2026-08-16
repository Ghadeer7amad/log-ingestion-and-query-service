import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { from as copyFrom } from 'pg-copy-streams';
import { copyPool } from '../index.js';
import { InsertBatch } from './logs.js';

// Experimental alternative to insertLogsRaw's INSERT...SELECT FROM UNNEST,
// behind the USE_COPY_INGEST flag (config.db.useCopyIngest). Real reason to
// try this again despite the earlier crash: COPY uses Postgres's dedicated
// BAS_BULKWRITE ring-buffer strategy (a small, fixed set of buffers reused
// in a cycle) instead of competing for general shared_buffers the way a
// normal INSERT does -- it doesn't just insert faster, it should directly
// reduce cache-eviction pressure on concurrent read queries, which is the
// read/write contention problem this whole investigation has been about.
//
// Uses `pg` + `pg-copy-streams`, not postgres.js's own COPY support --
// that's what crashed before (an unreachable internal emitter inside
// postgres.js's stream implementation threw an unhandled 'error' event
// under a genuine server-side COPY failure). Different library, different
// internal architecture, same protocol.
//
// Connects the source stream to the COPY sink with stream.pipeline(), not
// manual .pipe()/event wiring -- pipeline() is specifically what avoids the
// half-open-socket/stalled-backpressure failure mode this library is known
// for: it guarantees every stream in the chain gets destroyed on any
// error, on either end, instead of leaving one half of the pipe dangling.
//
// pipeline() alone is NOT sufficient, though -- confirmed directly by
// crash-safety testing (forced pg_terminate_backend on a connection mid-
// COPY): `pg.Client` is its own EventEmitter, independent of the two
// streams pipeline() is watching, and pg-copy-streams' CopyStreamQuery can
// surface a write failure (e.g. EPIPE from a killed connection) as an
// 'error' event on that `client` object rather than on either stream --
// pipeline() has no visibility into that path and the process crashed on
// an unhandled 'error' event despite it. Racing pipeline() against a
// client-level error listener closes that gap; whichever fires first ends
// the operation, and the listener is always removed again afterward (by
// reference, not removeAllListeners -- removing every listener would also
// strip pg-pool's own idle-connection listener that it re-attaches on
// release(), reintroducing the *other* unhandled-error crash this session
// already found and fixed at the pool level in db/index.ts).
export async function insertLogsCopy(batch: InsertBatch): Promise<number> {
  const rowCount = batch.timestamps.length;
  if (rowCount === 0) return 0;

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
    const source = Readable.from([buildCopyText(batch)]);

    await Promise.race([pipeline(source, copyStream), clientErrorPromise]);
    if (clientError) throw clientError; // defensive: pipeline() and the client error raced close enough that pipeline "won" but an error was still recorded

    // A COPY statement is all-or-nothing (one transaction, no partial-row
    // acceptance) -- if we got here, every row built into the text
    // payload was accepted, so this is exact, not an estimate.
    client.removeListener('error', onClientError);
    client.release();
    return rowCount;
  } catch (err) {
    client.removeListener('error', onClientError);
    // Tell the pool to discard this connection rather than recycle it --
    // its protocol state after a failed COPY mid-stream isn't something
    // to trust for the next caller.
    const error = err instanceof Error ? err : new Error(String(err));
    client.release(error);
    throw error;
  }
}

// Postgres COPY TEXT format: fields tab-separated, rows newline-separated,
// backslash/tab/newline/carriage-return backslash-escaped. Every column
// here is always present and non-null, so the reserved `\N` NULL sentinel
// is never emitted deliberately -- and since every literal backslash in
// the data is itself escaped to `\\`, a genuine backslash followed by
// "N" in source data can never be misread as that sentinel either.
//
// The cheap pre-check (skip the four .replace() calls when nothing in the
// field needs escaping) mirrors a fix already proven to matter under
// --prof profiling earlier in this project's own COPY attempt: without it,
// every field of every row pays for four regex passes regardless of
// whether escaping was ever needed.
const NEEDS_ESCAPE = /[\\\t\n\r]/;

function escapeCopyField(value: string): string {
  if (!NEEDS_ESCAPE.test(value)) return value;
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}

function buildCopyText(batch: InsertBatch): string {
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
  }
  return rows.join('\n') + '\n';
}

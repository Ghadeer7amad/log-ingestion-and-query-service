import { writeClient } from '../index.js';
import { ValidatedLog } from '../../validators/ingest.js';

// Single INSERT for whatever batch of rows it's given -- no internal
// chunking. Called only from ingestQueue.ts's flush(), which already caps
// how large a single call ever gets (FLUSH_ROW_THRESHOLD), so splitting
// further here would just turn one coalesced write back into several,
// undoing the point of coalescing.
export async function insertLogsRaw(validLogs: ValidatedLog[]): Promise<number> {
  if (validLogs.length === 0) return 0;

  const len = validLogs.length;
  const timestamps = new Array(len);
  const levels = new Array(len);
  const services = new Array(len);
  const messages = new Array(len);
  const attributesList = new Array(len);

  for (let j = 0; j < len; j++) {
    const log = validLogs[j];
    timestamps[j] = log.timestamp.toISOString();
    levels[j] = log.level;
    services[j] = log.service;
    messages[j] = log.message;
    attributesList[j] = JSON.stringify(log.attributes || {});
  }

  const result = await writeClient`
    INSERT INTO logs (timestamp, level, service, message, attributes)
    SELECT
      t.timestamp::timestamptz,
      t.level,
      t.service,
      t.message,
      t.attributes::jsonb
    FROM UNNEST(
      ${timestamps}::text[],
      ${levels}::text[],
      ${services}::text[],
      ${messages}::text[],
      ${attributesList}::jsonb[]
    ) AS t(timestamp, level, service, message, attributes)
  `;

  return result.count;
}

// COPY text-format escaping: backslash must be escaped first (it's COPY's
// own escape character), then tab/newline/CR -- all of which can appear
// raw in `message` (arbitrary user text) or inside a JSON-stringified
// attributes blob (JSON's own "\n" etc. is a literal backslash+n that COPY
// would otherwise try to interpret). Escaping the backslash first also
// protects a literal "\N" message from being misread as COPY's NULL
// sentinel, since it becomes "\\N" (a literal backslash + N) once escaped.
function escapeCopyField(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// Same batch, loaded via COPY FROM STDIN instead of INSERT...SELECT FROM
// UNNEST -- COPY skips per-row planner/executor overhead that the UNNEST
// subquery still goes through, which matters when the goal is minimizing
// CPU consumed per ingested row on a single-core Postgres container.
export async function insertLogsCopy(validLogs: ValidatedLog[]): Promise<number> {
  if (validLogs.length === 0) return 0;

  const lines = new Array(validLogs.length);
  for (let j = 0; j < validLogs.length; j++) {
    const log = validLogs[j];
    const ts = log.timestamp.toISOString();
    const level = escapeCopyField(log.level);
    const service = escapeCopyField(log.service);
    const message = escapeCopyField(log.message);
    const attributes = escapeCopyField(JSON.stringify(log.attributes || {}));
    lines[j] = `${ts}\t${level}\t${service}\t${message}\t${attributes}`;
  }
  const payload = lines.join('\n') + '\n';

  const query = writeClient`COPY logs (timestamp, level, service, message, attributes) FROM STDIN`;
  const stream = await query.writable();

  // The stream can emit its own 'error' independently of `query` rejecting.
  // Writable is an EventEmitter, and Node's default behavior for an
  // unhandled 'error' event is to throw and crash the whole process --
  // discovered the hard way (a genuine server-side COPY failure under load
  // took the entire app down instead of just failing this one batch). This
  // listener is required to prevent that; the actual failure still surfaces
  // correctly to the caller via `query` rejecting below.
  stream.on('error', () => {});

  stream.write(payload);
  stream.end();
  // The query itself resolves once the COPY completes server-side --
  // awaiting it (not just the stream's local 'finish') is what makes this
  // safe to treat as "durably accepted".
  await query;

  return validLogs.length;
}

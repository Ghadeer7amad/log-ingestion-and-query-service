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

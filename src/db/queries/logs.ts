import { writeClient } from '../index.js';

export interface InsertBatch {
  timestamps: string[];
  levels: string[];
  services: string[];
  messages: string[];
  attributesJson: string[];
}

// Single INSERT for whatever batch of rows it's given -- no internal
// chunking. Called only from ingestQueue.ts's flush(), which already caps
// how large a single call ever gets (FLUSH_ROW_THRESHOLD), so splitting
// further here would just turn one coalesced write back into several,
// undoing the point of coalescing.
//
// Takes the already-built parallel arrays directly -- validation
// (validators/ingest.ts) writes straight into this shape, so there's no
// per-row loop left to do here at all. This used to re-derive these same
// arrays from a `ValidatedLog[]` (calling `.toISOString()` and
// `JSON.stringify()` again on data that had just been converted from those
// exact representations one function earlier); removing that redundant
// pass was the point of the fusion, not just moving it here.
export async function insertLogsRaw(batch: InsertBatch): Promise<number> {
  if (batch.timestamps.length === 0) return 0;

  const result = await writeClient`
    INSERT INTO logs (timestamp, level, service, message, attributes)
    SELECT
      t.timestamp::timestamptz,
      t.level,
      t.service,
      t.message,
      t.attributes::jsonb
    FROM UNNEST(
      ${batch.timestamps}::text[],
      ${batch.levels}::text[],
      ${batch.services}::text[],
      ${batch.messages}::text[],
      ${batch.attributesJson}::jsonb[]
    ) AS t(timestamp, level, service, message, attributes)
  `;

  return result.count;
}

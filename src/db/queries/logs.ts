import { writeClient } from '../index.js';

export interface InsertBatch {
  timestamps: string[];
  levels: string[];
  services: string[];
  messages: string[];
  attributesJson: string[];
}

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

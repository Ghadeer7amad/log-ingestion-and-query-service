import { queryClient } from '../index.js';
import { ValidatedLog } from '../../validators/ingest.js';

export async function insertValidLogsBulk(validLogs: ValidatedLog[]): Promise<number> {
  if (validLogs.length === 0) return 0;

  const CHUNK_SIZE = 1000; 
  let totalInserted = 0;

  
  for (let i = 0; i < validLogs.length; i += CHUNK_SIZE) {
    const chunk = validLogs.slice(i, i + CHUNK_SIZE);
    const len = chunk.length;

    const timestamps = new Array(len);
    const levels = new Array(len);
    const services = new Array(len);
    const messages = new Array(len);
    const attributesList = new Array(len);

    for (let j = 0; j < len; j++) {
      const log = chunk[j];
      timestamps[j] = log.timestamp.toISOString();
      levels[j] = log.level;
      services[j] = log.service;
      messages[j] = log.message;
      attributesList[j] = JSON.stringify(log.attributes || {});
    }

    const result = await queryClient`
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

    totalInserted += result.count;
  }

  return totalInserted;
}
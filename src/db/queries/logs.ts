import { queryClient } from '../index.js';
import { ValidatedLog } from '../../validators/logValidator.js';

export async function insertValidLogsBulk(validLogs: ValidatedLog[]): Promise<number> {
  if (validLogs.length === 0) return 0;

  const len = validLogs.length;
  const timestamps = new Array(len);
  const levels = new Array(len);
  const services = new Array(len);
  const messages = new Array(len);
  const attributesList = new Array(len);

  for (let i = 0; i < len; i++) {
    const log = validLogs[i];
    timestamps[i] = log.timestamp.toISOString();
    levels[i] = log.level;
    services[i] = log.service;
    messages[i] = log.message;
    attributesList[i] = JSON.stringify(log.attributes || {});
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

  return result.count;
}
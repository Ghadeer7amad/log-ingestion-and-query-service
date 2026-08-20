import { describe, it, expect } from 'vitest';
import { buildCopyText } from '../../../src/db/queries/copyInsert.js';
import { InsertBatch } from '../../../src/db/queries/logs.js';

const NEEDS_ESCAPE = /[\\\t\n\r]/;
function referenceEscape(value: string): string {
  if (!NEEDS_ESCAPE.test(value)) return value;
  return value.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
}
function referenceBuildCopyText(batch: InsertBatch): string {
  const rowCount = batch.timestamps.length;
  const rows = new Array<string>(rowCount);
  for (let i = 0; i < rowCount; i++) {
    rows[i] =
      referenceEscape(batch.timestamps[i]) +
      '\t' +
      referenceEscape(batch.levels[i]) +
      '\t' +
      referenceEscape(batch.services[i]) +
      '\t' +
      referenceEscape(batch.messages[i]) +
      '\t' +
      referenceEscape(batch.attributesJson[i]);
  }
  return rows.join('\n') + '\n';
}

function makeBatch(rowCount: number, messageForIndex: (i: number) => string = (i) => `message ${i}`): InsertBatch {
  const timestamps: string[] = [];
  const levels: string[] = [];
  const services: string[] = [];
  const messages: string[] = [];
  const attributesJson: string[] = [];
  for (let i = 0; i < rowCount; i++) {
    timestamps.push(`2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
    levels.push(i % 2 === 0 ? 'info' : 'error');
    services.push(`service-${i % 7}`);
    messages.push(messageForIndex(i));
    attributesJson.push(JSON.stringify({ i }));
  }
  return { timestamps, levels, services, messages, attributesJson };
}

describe('buildCopyText', () => {
  it('matches the reference (unchunked) implementation exactly for a small batch', async () => {
    const batch = makeBatch(10);
    const actual = await buildCopyText(batch);
    expect(actual).toBe(referenceBuildCopyText(batch));
  });

  it('matches the reference implementation across multiple yield-chunk boundaries (YIELD_CHUNK_ROWS=500)', async () => {
    const batch = makeBatch(1200);
    const actual = await buildCopyText(batch);
    expect(actual).toBe(referenceBuildCopyText(batch));
  });

  it('matches the reference implementation exactly on a chunk-boundary-aligned row count (500)', async () => {
    const batch = makeBatch(500);
    const actual = await buildCopyText(batch);
    expect(actual).toBe(referenceBuildCopyText(batch));
  });

  it('handles an empty batch identically to the reference', async () => {
    const batch = makeBatch(0);
    const actual = await buildCopyText(batch);
    expect(actual).toBe(referenceBuildCopyText(batch));
    expect(actual).toBe('\n');
  });

  it('escapes backslash, tab, newline, and carriage return the same as the reference, including across a yield boundary', async () => {
    const batch = makeBatch(600, (i) => {
      if (i === 0) return 'has\\backslash';
      if (i === 1) return 'has\ttab';
      if (i === 2) return 'has\nnewline';
      if (i === 3) return 'has\rcarriage-return';
      if (i === 499) return 'right at the chunk boundary\\with\tescapes\n';
      if (i === 500) return 'right after the chunk boundary\\with\tescapes\n';
      return `plain message ${i}`;
    });
    const actual = await buildCopyText(batch);
    expect(actual).toBe(referenceBuildCopyText(batch));
    expect(actual).toContain('has\\\\backslash');
    expect(actual).toContain('has\\ttab');
    expect(actual).toContain('has\\nnewline');
    expect(actual).toContain('has\\rcarriage-return');
  });
});

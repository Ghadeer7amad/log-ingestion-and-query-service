import { describe, it, expect } from 'vitest';
import { validateLogBatch } from '../../src/validators/ingest.js';

const validEntry = () => ({
  timestamp: new Date().toISOString(),
  level: 'error',
  service: 'checkout',
  message: 'payment declined',
  attributes: { user_id: '42', retries: 3, active: true },
});

function validateOne(entry: unknown) {
  const { batch, rejected } = validateLogBatch([entry]);
  return {
    error: rejected[0]?.reason ?? null,
    accepted: batch.count === 1,
    batch,
  };
}

describe('validateLogBatch', () => {
  it('accepts a fully valid entry', () => {
    const { error, accepted, batch } = validateOne(validEntry());
    expect(error).toBeNull();
    expect(accepted).toBe(true);
    expect(batch.services[0]).toBe('checkout');
    expect(JSON.parse(batch.attributesJson[0])).toEqual({ user_id: '42', retries: 3, active: true });
  });

  it('accepts an entry with no attributes at all', () => {
    const entry = validEntry();
    delete (entry as any).attributes;
    const { error, batch } = validateOne(entry);
    expect(error).toBeNull();
    expect(JSON.parse(batch.attributesJson[0])).toEqual({});
  });

  it.each([
    ['non-object entry', 'not an object'],
    ['array entry', ['nope']],
    ['null entry', null],
  ])('rejects %s', (_name, bad) => {
    const { error, accepted } = validateOne(bad);
    expect(error).not.toBeNull();
    expect(accepted).toBe(false);
  });

  it('rejects a missing timestamp', () => {
    const entry = validEntry();
    delete (entry as any).timestamp;
    const { error } = validateOne(entry);
    expect(error).toMatch(/timestamp/);
  });

  it('rejects an unparseable timestamp', () => {
    const { error } = validateOne({ ...validEntry(), timestamp: 'not-a-date' });
    expect(error).toMatch(/ISO 8601/);
  });

  it('rejects a timestamp more than 5 minutes in the future', () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { error } = validateOne({ ...validEntry(), timestamp: future });
    expect(error).toMatch(/future/);
  });

  it('accepts a timestamp just under 5 minutes in the future', () => {
    const nearFuture = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    const { error } = validateOne({ ...validEntry(), timestamp: nearFuture });
    expect(error).toBeNull();
  });

  it('stores the timestamp as a canonical ISO string, and its epoch in parallel', () => {
    const t = new Date('2026-08-15T10:00:00.000Z').toISOString();
    const { batch } = validateOne({ ...validEntry(), timestamp: t });
    expect(batch.timestamps[0]).toBe(t);
    expect(batch.timestampEpochs[0]).toBe(Date.parse(t));
  });

  it('rejects an invalid level', () => {
    const { error } = validateOne({ ...validEntry(), level: 'critical' });
    expect(error).toBe("invalid level: 'critical'");
  });

  it.each(['debug', 'info', 'warn', 'error'])('accepts level "%s"', (level) => {
    const { error } = validateOne({ ...validEntry(), level });
    expect(error).toBeNull();
  });

  it('rejects an empty service string', () => {
    const { error } = validateOne({ ...validEntry(), service: '   ' });
    expect(error).toMatch(/service/);
  });

  it('rejects an empty message string', () => {
    const { error } = validateOne({ ...validEntry(), message: '' });
    expect(error).toMatch(/message/);
  });

  it('rejects attributes that are not a flat object (array)', () => {
    const { error } = validateOne({ ...validEntry(), attributes: ['nope'] });
    expect(error).toMatch(/flat object/);
  });

  it('rejects a nested object inside attributes', () => {
    const { error } = validateOne({
      ...validEntry(),
      attributes: { region: { nested: true } },
    });
    expect(error).toMatch(/nested objects or arrays/);
  });

  it('rejects an array value inside attributes', () => {
    const { error } = validateOne({
      ...validEntry(),
      attributes: { tags: ['a', 'b'] },
    });
    expect(error).toMatch(/nested objects or arrays/);
  });

  it('silently drops null/undefined attribute values rather than rejecting', () => {
    const { error, batch } = validateOne({
      ...validEntry(),
      attributes: { user_id: '42', ignored: null },
    });
    expect(error).toBeNull();
    expect(JSON.parse(batch.attributesJson[0])).toEqual({ user_id: '42' });
  });

  it('preserves numeric and boolean attribute types (not stringified)', () => {
    const { batch } = validateOne({
      ...validEntry(),
      attributes: { retries: 3, active: false },
    });
    const attrs = JSON.parse(batch.attributesJson[0]);
    expect(attrs.retries).toBe(3);
    expect(typeof attrs.retries).toBe('number');
    expect(attrs.active).toBe(false);
    expect(typeof attrs.active).toBe('boolean');
  });

  it('escapes special characters in attribute keys/values correctly', () => {
    const { batch } = validateOne({
      ...validEntry(),
      attributes: { 'weird "key"': 'value with "quotes" and \\backslash\\ and \nnewline' },
    });
    const attrs = JSON.parse(batch.attributesJson[0]);
    expect(attrs['weird "key"']).toBe('value with "quotes" and \\backslash\\ and \nnewline');
  });

  it('handles a batch with a mix of accepted and rejected entries, preserving indices', () => {
    const { batch, rejected } = validateLogBatch([
      validEntry(),
      { ...validEntry(), level: 'bogus' },
      validEntry(),
    ]);
    expect(batch.count).toBe(2);
    expect(rejected).toEqual([{ index: 1, reason: "invalid level: 'bogus'" }]);
  });
});

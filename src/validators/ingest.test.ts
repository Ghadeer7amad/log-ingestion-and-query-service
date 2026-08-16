import { describe, it, expect } from 'vitest';
import { validateAndTransformLog } from './ingest.js';

const validEntry = () => ({
  timestamp: new Date().toISOString(),
  level: 'error',
  service: 'checkout',
  message: 'payment declined',
  attributes: { user_id: '42', retries: 3, active: true },
});

describe('validateAndTransformLog', () => {
  it('accepts a fully valid entry', () => {
    const { error, data } = validateAndTransformLog(validEntry());
    expect(error).toBeNull();
    expect(data?.service).toBe('checkout');
    expect(data?.attributes).toEqual({ user_id: '42', retries: 3, active: true });
  });

  it('accepts an entry with no attributes at all', () => {
    const entry = validEntry();
    delete (entry as any).attributes;
    const { error, data } = validateAndTransformLog(entry);
    expect(error).toBeNull();
    expect(data?.attributes).toEqual({});
  });

  it.each([
    ['non-object entry', 'not an object'],
    ['array entry', ['nope']],
    ['null entry', null],
  ])('rejects %s', (_name, bad) => {
    const { error, data } = validateAndTransformLog(bad);
    expect(error).not.toBeNull();
    expect(data).toBeNull();
  });

  it('rejects a missing timestamp', () => {
    const entry = validEntry();
    delete (entry as any).timestamp;
    const { error } = validateAndTransformLog(entry);
    expect(error).toMatch(/timestamp/);
  });

  it('rejects an unparseable timestamp', () => {
    const { error } = validateAndTransformLog({ ...validEntry(), timestamp: 'not-a-date' });
    expect(error).toMatch(/ISO 8601/);
  });

  it('rejects a timestamp more than 5 minutes in the future', () => {
    const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const { error } = validateAndTransformLog({ ...validEntry(), timestamp: future });
    expect(error).toMatch(/future/);
  });

  it('accepts a timestamp just under 5 minutes in the future', () => {
    const nearFuture = new Date(Date.now() + 4 * 60 * 1000).toISOString();
    const { error } = validateAndTransformLog({ ...validEntry(), timestamp: nearFuture });
    expect(error).toBeNull();
  });

  it('rejects an invalid level', () => {
    const { error } = validateAndTransformLog({ ...validEntry(), level: 'critical' });
    expect(error).toBe("invalid level: 'critical'");
  });

  it.each(['debug', 'info', 'warn', 'error'])('accepts level "%s"', (level) => {
    const { error } = validateAndTransformLog({ ...validEntry(), level });
    expect(error).toBeNull();
  });

  it('rejects an empty service string', () => {
    const { error } = validateAndTransformLog({ ...validEntry(), service: '   ' });
    expect(error).toMatch(/service/);
  });

  it('rejects an empty message string', () => {
    const { error } = validateAndTransformLog({ ...validEntry(), message: '' });
    expect(error).toMatch(/message/);
  });

  it('rejects attributes that are not a flat object (array)', () => {
    const { error } = validateAndTransformLog({ ...validEntry(), attributes: ['nope'] });
    expect(error).toMatch(/flat object/);
  });

  it('rejects a nested object inside attributes', () => {
    const { error } = validateAndTransformLog({
      ...validEntry(),
      attributes: { region: { nested: true } },
    });
    expect(error).toMatch(/nested objects or arrays/);
  });

  it('rejects an array value inside attributes', () => {
    const { error } = validateAndTransformLog({
      ...validEntry(),
      attributes: { tags: ['a', 'b'] },
    });
    expect(error).toMatch(/nested objects or arrays/);
  });

  it('silently drops null/undefined attribute values rather than rejecting', () => {
    const { error, data } = validateAndTransformLog({
      ...validEntry(),
      attributes: { user_id: '42', ignored: null },
    });
    expect(error).toBeNull();
    expect(data?.attributes).toEqual({ user_id: '42' });
  });

  it('preserves numeric and boolean attribute types (not stringified)', () => {
    const { data } = validateAndTransformLog({
      ...validEntry(),
      attributes: { retries: 3, active: false },
    });
    expect(data?.attributes.retries).toBe(3);
    expect(typeof data?.attributes.retries).toBe('number');
    expect(data?.attributes.active).toBe(false);
    expect(typeof data?.attributes.active).toBe('boolean');
  });
});

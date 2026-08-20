import { describe, it, expect, vi } from 'vitest';
import { validateGetLogsQuery } from './query.js';

// validateGetLogsQuery writes 400 responses directly to `res` rather than
// throwing/returning an error object, so tests need a minimal fake
// Request/Response rather than calling the function purely.
function fakeReqRes(query: Record<string, any>) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const req = { query } as any;
  const res = { status } as any;
  return { req, res, status, json };
}

describe('validateGetLogsQuery', () => {
  it('accepts an empty query with all defaults', () => {
    const { req, res, status } = fakeReqRes({});
    const result = validateGetLogsQuery(req, res);
    expect(status).not.toHaveBeenCalled();
    expect(result?.limit).toBe(100);
  });

  it('rejects an unsupported log level', () => {
    const { req, res, status, json } = fakeReqRes({ level: 'critical' });
    const result = validateGetLogsQuery(req, res);
    expect(result).toBeNull();
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Unsupported log level' });
  });

  it.each(['debug', 'info', 'warn', 'error'])('accepts level "%s"', (level) => {
    const { req, res, status } = fakeReqRes({ level });
    validateGetLogsQuery(req, res);
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric limit', () => {
    const { req, res, status, json } = fakeReqRes({ limit: 'abc' });
    validateGetLogsQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Limit must be a valid integer' });
  });

  it.each([0, -1, 1001, 5000])('rejects an out-of-range limit: %i', (limit) => {
    const { req, res, status } = fakeReqRes({ limit: String(limit) });
    validateGetLogsQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it.each([1, 100, 1000])('accepts an in-range limit: %i', (limit) => {
    const { req, res, status } = fakeReqRes({ limit: String(limit) });
    const result = validateGetLogsQuery(req, res);
    expect(status).not.toHaveBeenCalled();
    expect(result?.limit).toBe(limit);
  });

  it('rejects an invalid "since" timestamp', () => {
    const { req, res, status, json } = fakeReqRes({ since: 'not-a-date' });
    validateGetLogsQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid timestamp for "since"' });
  });

  it('rejects "until" earlier than "since"', () => {
    const { req, res, status, json } = fakeReqRes({
      since: '2026-07-20T15:00:00Z',
      until: '2026-07-20T14:00:00Z',
    });
    validateGetLogsQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: '"until" cannot be earlier than "since"' });
  });

  it('accepts "until" equal to "since"', () => {
    const { req, res, status } = fakeReqRes({
      since: '2026-07-20T14:00:00Z',
      until: '2026-07-20T14:00:00Z',
    });
    validateGetLogsQuery(req, res);
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects a malformed (non-base64/non-JSON) cursor', () => {
    const { req, res, status, json } = fakeReqRes({ cursor: '!!!not valid base64 json!!!' });
    validateGetLogsQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid or malformed cursor' });
  });

  it('rejects a structurally invalid cursor (wrong field types)', () => {
    const badCursor = Buffer.from(JSON.stringify({ timestamp: 123, id: 'not-a-number' })).toString('base64');
    const { req, res, status, json } = fakeReqRes({ cursor: badCursor });
    validateGetLogsQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Malformed cursor structure' });
  });

  it('accepts a well-formed cursor', () => {
    const goodCursor = Buffer.from(
      JSON.stringify({ timestamp: '2026-07-20T14:32:01.123Z', id: 42 })
    ).toString('base64');
    const { req, res, status } = fakeReqRes({ cursor: goodCursor });
    const result = validateGetLogsQuery(req, res);
    expect(status).not.toHaveBeenCalled();
    expect(result?.parsedCursor).toEqual({ timestamp: '2026-07-20T14:32:01.123Z', id: 42 });
  });

  it('extracts attr.<key> params into the attributes map', () => {
    const { req, res, status } = fakeReqRes({ 'attr.user_id': '42', 'attr.region': 'eu-west' });
    const result = validateGetLogsQuery(req, res);
    expect(status).not.toHaveBeenCalled();
    expect(result?.attributes).toEqual({ user_id: '42', region: 'eu-west' });
  });
});

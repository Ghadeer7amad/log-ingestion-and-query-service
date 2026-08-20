import { describe, it, expect, vi } from 'vitest';
import { validateAggregateQuery } from '../../src/validators/aggregate.js';

function fakeReqRes(query: Record<string, any>) {
  const json = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  const req = { query } as any;
  const res = { status } as any;
  return { req, res, status, json };
}

const validQuery = () => ({
  since: '2026-07-20T14:00:00Z',
  until: '2026-07-20T15:00:00Z',
  bucket: '1m',
});

describe('validateAggregateQuery', () => {
  it('accepts a minimal valid query', () => {
    const { req, res, status } = fakeReqRes(validQuery());
    const result = validateAggregateQuery(req, res);
    expect(status).not.toHaveBeenCalled();
    expect(result?.bucket).toBe('1m');
    expect(result?.group_by).toBeUndefined();
  });

  it.each(['since', 'until', 'bucket'])('rejects when "%s" is missing', (missing) => {
    const query = validQuery();
    delete (query as any)[missing];
    const { req, res, status, json } = fakeReqRes(query);
    validateAggregateQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: 'Missing required parameters: since, until, and bucket are required',
    });
  });

  it('rejects "until" earlier than "since"', () => {
    const { req, res, status } = fakeReqRes({
      ...validQuery(),
      since: '2026-07-20T15:00:00Z',
      until: '2026-07-20T14:00:00Z',
    });
    validateAggregateQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it.each(['1m', '5m', '1h', '1d'])('accepts bucket size "%s"', (bucket) => {
    const { req, res, status } = fakeReqRes({ ...validQuery(), bucket });
    validateAggregateQuery(req, res);
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects an invalid bucket size', () => {
    const { req, res, status, json } = fakeReqRes({ ...validQuery(), bucket: '2m' });
    validateAggregateQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({ error: 'Invalid bucket value. Allowed: 1m, 5m, 1h, 1d' });
  });

  it.each(['service', 'level'])('accepts group_by "%s"', (group_by) => {
    const { req, res, status } = fakeReqRes({ ...validQuery(), group_by });
    validateAggregateQuery(req, res);
    expect(status).not.toHaveBeenCalled();
  });

  it('rejects an invalid group_by', () => {
    const { req, res, status } = fakeReqRes({ ...validQuery(), group_by: 'timestamp' });
    validateAggregateQuery(req, res);
    expect(status).toHaveBeenCalledWith(400);
  });

  it('when group_by is absent, result has no group_by set', () => {
    const { req, res } = fakeReqRes(validQuery());
    const result = validateAggregateQuery(req, res);
    expect(result?.group_by).toBeUndefined();
  });

  it('extracts attr.<key> params, dropping ones with an empty key', () => {
    const { req, res } = fakeReqRes({ ...validQuery(), 'attr.user_id': '42', 'attr.': 'ignored' });
    const result = validateAggregateQuery(req, res);
    expect(result?.attributes).toEqual({ user_id: '42' });
  });

  it('leaves attributes undefined when none are provided', () => {
    const { req, res } = fakeReqRes(validQuery());
    const result = validateAggregateQuery(req, res);
    expect(result?.attributes).toBeUndefined();
  });
});

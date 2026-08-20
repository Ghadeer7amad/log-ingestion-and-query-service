export interface ValidatedBatch {
  count: number;
  timestamps: string[];
  timestampEpochs: number[];
  levels: string[];
  services: string[];
  messages: string[];
  attributesJson: string[];
}

export interface RejectedEntry {
  index: number;
  reason: string;
}

const ALLOWED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const FIVE_MINUTES_MS = 5 * 60 * 1000;

function emptyBatch(): ValidatedBatch {
  return {
    count: 0,
    timestamps: [],
    timestampEpochs: [],
    levels: [],
    services: [],
    messages: [],
    attributesJson: [],
  };
}

export function validateLogBatch(rawLogs: unknown[]): { batch: ValidatedBatch; rejected: RejectedEntry[] } {
  const batch = emptyBatch();
  const rejected: RejectedEntry[] = [];

  for (let i = 0; i < rawLogs.length; i++) {
    const reason = validateInto(rawLogs[i], batch);
    if (reason) rejected.push({ index: i, reason });
  }

  return { batch, rejected };
}

function validateInto(entry: unknown, batch: ValidatedBatch): string | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return 'log entry must be a valid object';
  }
  const e = entry as Record<string, unknown>;

  if (typeof e.timestamp !== 'string' || e.timestamp.trim() === '') {
    return 'invalid timestamp: must be a non-empty ISO 8601 string';
  }
  const parsedTime = Date.parse(e.timestamp);
  if (isNaN(parsedTime)) {
    return 'invalid timestamp format: must be valid ISO 8601';
  }
  if (parsedTime > Date.now() + FIVE_MINUTES_MS) {
    return 'timestamp cannot be more than 5 minutes in the future';
  }

  if (typeof e.level !== 'string' || !ALLOWED_LEVELS.has(e.level)) {
    return `invalid level: '${e.level as string}'`;
  }

  if (typeof e.service !== 'string' || e.service.trim() === '') {
    return 'service must be a non-empty string';
  }

  if (typeof e.message !== 'string' || e.message.trim() === '') {
    return 'message must be a non-empty string';
  }

  let attrJson = '{}';
  if (e.attributes !== undefined && e.attributes !== null) {
    if (typeof e.attributes !== 'object' || Array.isArray(e.attributes)) {
      return 'attributes must be a flat object';
    }
    const attrs = e.attributes as Record<string, unknown>;
    let body = '';
    let first = true;
    for (const key in attrs) {
      const val = attrs[key];
      if (val === null || val === undefined) continue;

      const valType = typeof val;
      if (valType === 'object') {
        return `nested objects or arrays are not allowed in attribute: '${key}'`;
      }
      if (valType !== 'string' && valType !== 'number' && valType !== 'boolean') {
        return `attribute value for '${key}' must be string, number, or boolean`;
      }

      if (!first) body += ',';
      body += JSON.stringify(key) + ':' + JSON.stringify(val);
      first = false;
    }
    attrJson = '{' + body + '}';
  }

  batch.timestamps.push(new Date(parsedTime).toISOString());
  batch.timestampEpochs.push(parsedTime);
  batch.levels.push(e.level);
  batch.services.push(e.service);
  batch.messages.push(e.message);
  batch.attributesJson.push(attrJson);
  batch.count++;

  return null;
}

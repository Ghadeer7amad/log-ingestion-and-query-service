// Structure-of-arrays, not array-of-structures: validation writes straight
// into the same parallel arrays insertLogsRaw needs for its UNNEST insert,
// instead of building a `ValidatedLog` object per entry that gets thrown
// away two functions later. Profiled (--prof) under sustained load before
// this change: GC alone was 23.8% of all CPU ticks, the single largest
// named cost in the system -- bigger than every application function
// combined. The old per-entry object round-tripped each field through an
// extra representation for no reason: `timestamp` went JSON string -> Date
// object -> ISO string (three representations of one instant); `attributes`
// went JSON string -> validated object -> JSON.stringify'd string again
// (rebuilding the same JSON it started as). Neither round-trip was ever
// necessary -- Postgres's `::timestamptz` and `::jsonb` casts don't care
// what representation they receive, they normalize on ingest regardless.
export interface ValidatedBatch {
  count: number;
  timestamps: string[]; // canonical ISO strings, ready for ::timestamptz
  timestampEpochs: number[]; // Date.parse() result, parallel to timestamps -- lets the aggregate cache bucket by minute without ever constructing a Date
  levels: string[];
  services: string[];
  messages: string[];
  attributesJson: string[]; // built directly during validation; never round-tripped through a plain object
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

// Returns an error reason string on rejection, or null on success -- on
// success the entry's fields are pushed directly into `batch`'s arrays.
// Nothing is committed to `batch` until every check has passed, so a
// failure partway through (e.g. a bad attribute on the third key) leaves
// no partial trace, same all-or-nothing semantics the old per-entry object
// had.
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

  // Build the attributes JSON string directly -- no intermediate object.
  // JSON.stringify on individual keys/values still does correct escaping
  // (quotes, backslashes, unicode); what's skipped is ever holding the
  // whole thing as a live JS object just to immediately re-stringify it.
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

  // Canonical ISO string, same as the old `new Date(parsedTime).toISOString()`
  // -- kept (not the raw input string) so a Postgres-parseable format is
  // guaranteed regardless of exactly how lenient the client's original
  // timestamp text was. The one allocation this still costs (a short-lived
  // Date, immediately discarded) is far cheaper than the object it
  // replaces: no ValidatedLog wrapper, no sanitizedAttributes object, no
  // second JSON.stringify pass.
  batch.timestamps.push(new Date(parsedTime).toISOString());
  batch.timestampEpochs.push(parsedTime);
  batch.levels.push(e.level);
  batch.services.push(e.service);
  batch.messages.push(e.message);
  batch.attributesJson.push(attrJson);
  batch.count++;

  return null;
}

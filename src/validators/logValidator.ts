export interface ValidatedLog {
  timestamp: Date;
  level: string;
  service: string;
  message: string;
  attributes: Record<string, string | number | boolean>;
}

const ALLOWED_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function validateAndTransformLog(entry: any): { error: string | null; data: ValidatedLog | null } {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return { error: 'log entry must be a valid object', data: null };
  }

  if (typeof entry.timestamp !== 'string' || entry.timestamp.trim() === '') {
    return { error: 'invalid timestamp: must be a non-empty ISO 8601 string', data: null };
  }
  const parsedTime = Date.parse(entry.timestamp);
  if (isNaN(parsedTime)) {
    return { error: 'invalid timestamp format: must be valid ISO 8601', data: null };
  }
  if (parsedTime > Date.now() + FIVE_MINUTES_MS) {
    return { error: 'timestamp cannot be more than 5 minutes in the future', data: null };
  }


  if (typeof entry.level !== 'string' || !ALLOWED_LEVELS.has(entry.level)) {
    return { error: `invalid level: '${entry.level}'`, data: null };
  }


  if (typeof entry.service !== 'string' || entry.service.trim() === '') {
    return { error: 'service must be a non-empty string', data: null };
  }


  if (typeof entry.message !== 'string' || entry.message.trim() === '') {
    return { error: 'message must be a non-empty string', data: null };
  }


  const sanitizedAttributes: Record<string, string | number | boolean> = {};

  if (entry.attributes !== undefined && entry.attributes !== null) {
    if (typeof entry.attributes !== 'object' || Array.isArray(entry.attributes)) {
      return { error: 'attributes must be a flat object', data: null };
    }

    for (const key in entry.attributes) {
      const val = entry.attributes[key];


      if (val === null || val === undefined) {
        continue;
      }

      const valType = typeof val;
      if (valType === 'object') {
        return { error: `nested objects or arrays are not allowed in attribute: '${key}'`, data: null };
      }


      if (valType === 'string' || valType === 'number' || valType === 'boolean') {
        sanitizedAttributes[key] = val;
      } else {
        return { error: `attribute value for '${key}' must be string, number, or boolean`, data: null };
      }
    }
  }

  return {
    error: null,
    data: {
      timestamp: new Date(parsedTime), 
      level: entry.level,
      service: entry.service,
      message: entry.message,
      attributes: sanitizedAttributes,
    },
  };
}
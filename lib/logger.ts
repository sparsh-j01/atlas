import 'server-only'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

// Events must be fixed application strings, never exception messages or user input.
export const EVENTS = new Set([
  'ocr failed for one image', 'ingestion reached a state with no stage',
  'ingestion stage paused mid-way', 'ingestion stage complete', 'ingestion stage failed',
  'ingestion transaction interrupted', 'ai usage not recorded', 'ai reservation not settled',
  'alert', 'alert webhook refused', 'alert not sent', 'daily cron', 'blueprint phase failed',
  'deck save failed', 'gemini call failed', 'gemini request threw', 'document upload failed',
  'broadcast failed', 'broadcast threw', 'document upload cleanup failed', 'slide retrieval failed',
  'document upload link failed', 'document upload rejected', 'document confirm failed',
  'ocr batch failed', 'ingestion run threw',
])
const SAFE_LABELS = new Set(['stage', 'state', 'next', 'format', 'model', 'code', 'event', 'kind'])
const SAFE_NUMBERS = new Set(['status', 'durationMs', 'reaped', 'failed', 'tombstones', 'inputTokens', 'outputTokens'])
const SAFE_IDS = new Set(['documentId', 'jobId', 'traceId'])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

/** DB errors contain SQL and parameters. Retain only SQLSTATE, never message/stack/detail. */
export function safeError(error: unknown): { category: string; sqlState?: string } {
  let current = error
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const candidate = current as { code?: unknown; cause?: unknown }
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code))
      return { category: 'database', sqlState: candidate.code }
    current = candidate.cause
  }
  return { category: error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'operation_failed' }
}

function safeContext(context: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(context)) {
    // Unknown fields, nested objects and arrays are omitted. Key blacklists miss private
    // text embedded in innocent-looking fields such as message and reason.
    if (key === 'error') result.error = safeError(value)
    else if (SAFE_NUMBERS.has(key) && typeof value === 'number' && Number.isFinite(value)) result[key] = value
    else if (SAFE_LABELS.has(key) && typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value)) result[key] = value
    else if (SAFE_IDS.has(key) && typeof value === 'string' && UUID.test(value)) result[key] = value
  }
  return result
}

function write(level: LogLevel, message: string, context?: Record<string, unknown>, traceId?: string) {
  console[level](JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message: EVENTS.has(message) ? message : 'unrecognized event',
    ...(context ? { context: safeContext(context) } : {}),
    ...(traceId && UUID.test(traceId) ? { traceId } : {}),
  }))
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>, traceId?: string) {
    if (process.env.NODE_ENV === 'development') write('debug', message, context, traceId)
  },
  info(message: string, context?: Record<string, unknown>, traceId?: string) { write('info', message, context, traceId) },
  warn(message: string, context?: Record<string, unknown>, traceId?: string) { write('warn', message, context, traceId) },
  error(message: string, context?: Record<string, unknown>, traceId?: string) { write('error', message, context, traceId) },
}

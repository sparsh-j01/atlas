import 'server-only'

type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogEntry {
  timestamp: string
  level: LogLevel
  message: string
  context?: Record<string, unknown>
  traceId?: string
}

// Substrings that mark a field as a secret or as personal data. Matched case-insensitively
// against the KEY, so `hostToken`, `csrf_token` and `apiKey` are all caught by 'token'/'key'.
//
// Opaque row ids (documentId, ownerId, jobId, participantId) are deliberately NOT here.
// They identify a row, not a person, and redacting them made every log line unusable for
// the thing logs are for — following one document through five ingestion stages. Redacting
// what cannot be correlated is not privacy, it is just a log nobody can read. Anything
// that resolves to a human (email) or grants access (token, key, cookie) still goes.
const SECRET_FIELDS = [
  'email',
  'password',
  'token',
  'secret',
  'key',
  'authorization',
  'cookie',
  'nickname',
]

function redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase()
    if (SECRET_FIELDS.some(field => lowerKey.includes(field))) {
      result[key] = '[REDACTED]'
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = redactSecrets(value as Record<string, unknown>)
    } else if (Array.isArray(value)) {
      result[key] = value.map(v => 
        v && typeof v === 'object' ? redactSecrets(v as Record<string, unknown>) : v
      )
    } else {
      result[key] = value
    }
  }
  return result
}

function formatEntry(entry: LogEntry): string {
  const { timestamp, level, message, context, traceId } = entry
  const base = { timestamp, level, message, traceId }
  const loggedContext = context ? redactSecrets(context) : undefined
  return JSON.stringify({ ...base, ...(loggedContext ? { context: loggedContext } : {}) })
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>, traceId?: string) {
    if (process.env.NODE_ENV === 'development') {
      console.debug(formatEntry({ timestamp: new Date().toISOString(), level: 'debug', message, context, traceId }))
    }
  },
  info(message: string, context?: Record<string, unknown>, traceId?: string) {
    console.info(formatEntry({ timestamp: new Date().toISOString(), level: 'info', message, context, traceId }))
  },
  warn(message: string, context?: Record<string, unknown>, traceId?: string) {
    console.warn(formatEntry({ timestamp: new Date().toISOString(), level: 'warn', message, context, traceId }))
  },
  error(message: string, context?: Record<string, unknown>, traceId?: string) {
    console.error(formatEntry({ timestamp: new Date().toISOString(), level: 'error', message, context, traceId }))
  },
}
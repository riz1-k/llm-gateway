import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger } from 'pino';

export interface LoggerConfig {
  level?: string;
  /** Pretty-print (requires the optional `pino-pretty` package). */
  pretty?: boolean;
  /** Destination stream (tests). */
  destination?: NodeJS.WritableStream;
}

/**
 * Structured JSON logger. Prompt/response bodies are never logged by default; credentials that
 * might appear in logged objects are redacted.
 */
export function createLogger(cfg: LoggerConfig = {}): Logger {
  const options: LoggerOptions = {
    level: cfg.level ?? 'info',
    base: { service: 'switchyard' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'authorization',
        'headers.authorization',
        '*.headers.authorization',
        'api_key',
        '*.api_key',
        'password',
        '*.password',
        'admin_token',
        '*.admin_token',
      ],
      censor: '[redacted]',
    },
    formatters: { level: (label) => ({ level: label }) },
  };
  if (cfg.pretty) {
    return pino({ ...options, transport: { target: 'pino-pretty', options: { colorize: true } } });
  }
  return cfg.destination ? pino(options, cfg.destination as pino.DestinationStream) : pino(options);
}

/** A logger that discards everything (tests, library embedding). */
export const silentLogger = (): Logger => pino({ level: 'silent' });

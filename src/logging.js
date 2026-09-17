import pino from 'pino';

const level = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'access_token',
      'refresh_token',
      '*.access_token',
      '*.refresh_token',
      'apiKey',
      'api_key',
      'password',
      '*.password',
    ],
    censor: '[REDACTED]',
  },
  base: undefined,
});

// Helper for modules that receive a child logger
export function childLogger(bindings) {
  return logger.child(bindings);
}

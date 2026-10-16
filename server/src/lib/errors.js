import { ZodError } from 'zod';

/** An error that carries an HTTP status and a stable code for the client. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Please sign in again') => new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'You are not allowed to do that') =>
  new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message, details) => new AppError(409, 'CONFLICT', message, details);
export const gone = (message) => new AppError(410, 'GONE', message);

/** Turns zod issues into `[{ path, message }]` that the UI and the agent can both read. */
export const zodIssues = (error) =>
  error.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));

/** Parses with a zod schema, throwing a 400 with readable issues on failure. */
export const parseOrThrow = (schema, value, what = 'input') => {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest(`Invalid ${what}`, zodIssues(result.error));
  return result.data;
};

export const errorHandler = (err, req, res, _next) => {
  if (err instanceof ZodError) err = badRequest('Invalid input', zodIssues(err));
  if (err?.type === 'entity.parse.failed') err = badRequest('Request body is not valid JSON');
  if (err?.type === 'entity.too.large') err = new AppError(413, 'TOO_LARGE', 'Request body is too large');

  const status = err.status && err.status < 600 ? err.status : 500;
  if (status >= 500) req.log?.error({ err }, 'request failed');
  if (res.headersSent) return;
  res.status(status).json({
    error: {
      code: err.code ?? 'INTERNAL',
      message: status >= 500 ? 'Something went wrong on the server' : err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
};

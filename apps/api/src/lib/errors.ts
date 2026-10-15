/**
 * Errors carry a plain-language message that tells the user what to do next
 * (SRS 3.1.1), plus a stable code for clients.
 */
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Please sign in to continue.') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have access to this. Ask a BTBG administrator if you need it.') =>
  new AppError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} was not found. It may have been removed.`);
export const conflict = (message: string, details?: unknown) => new AppError(409, 'conflict', message, details);
export const ruleViolation = (message: string, details?: unknown) => new AppError(422, 'rule_violation', message, details);

export function assert(condition: unknown, err: AppError): asserts condition {
  if (!condition) throw err;
}

export type ErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'forbidden'
  | 'already_exists'
  | 'rev_mismatch'
  | 'invalid_path'
  | 'invalid_request'
  | 'patch_target_not_found'
  | 'patch_target_ambiguous'
  | 'folder_not_empty'
  | 'invalid_base'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = () => new ApiError(404, 'not_found', 'Not found');
export const forbidden = (what: string) => new ApiError(403, 'forbidden', `This account may not ${what} here`);
export const invalidRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, 'invalid_request', message, details);
export const alreadyExists = (path: string) => new ApiError(409, 'already_exists', `Already exists: ${path}`);

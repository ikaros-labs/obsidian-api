import type { CallResult } from './caller.js';

/** A REST error envelope, turned into an MCP tool error (`isError: true`). */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** What to do next, per REST error code. Keeps hidden and missing paths indistinguishable. */
const HINTS: Record<string, string> = {
  not_found: 'Not found, or not visible to this account. spall_whoami lists your folders.',
  forbidden: 'spall_whoami lists what this account may do in each folder.',
  rev_mismatch: 'The note changed since you read it. Re-read it (view=outline is cheap) and retry with the current rev.',
  patch_target_ambiguous: 'Retry with `index` set to one of the candidates.',
  patch_target_not_found: 'Check the heading path with spall_read view=outline.',
  already_exists: 'Pick another name, or use on_conflict=rename.',
  not_a_note: 'spall_read, spall_edit, spall_move and spall_trash take notes and .base files only.',
  invalid_base: 'Nothing was written. Fix the YAML and retry; spall_read view=outline shows the current views.',
  rate_limited: 'Wait retry_after seconds, then retry.',
  audit_unavailable: 'Nothing was changed: the server cannot write its audit log. Retry later.',
  unauthorized: 'The token is missing, invalid or expired.',
};

export function errorFromResponse(res: CallResult): ToolError {
  let env: { error?: { code?: string; message?: string; details?: Record<string, unknown> } } = {};
  try {
    env = JSON.parse(res.body);
  } catch {
    // not an envelope
  }
  const code = env.error?.code ?? (res.status === 404 ? 'not_found' : 'internal');
  // not_found carries no detail beyond suggestions drawn from visible paths, so a hidden note and a
  // missing one read the same.
  if (code === 'not_found') {
    const dym = env.error?.details?.did_you_mean;
    if (!Array.isArray(dym) || dym.length === 0) return new ToolError(code, HINTS.not_found!);
    const list = (dym as string[]).map((p) => JSON.stringify(p)).join(' or ');
    return new ToolError(code, `Not found, or not visible to this account. Did you mean ${list}?`, { did_you_mean: dym });
  }
  const details = { ...env.error?.details };
  if (code === 'rate_limited' && details.retry_after === undefined && res.headers['retry-after']) {
    details.retry_after = Number(res.headers['retry-after']);
  }
  const message = env.error?.message ?? `HTTP ${res.status}`;
  return new ToolError(code, HINTS[code] ? `${message}. ${HINTS[code]}` : message, Object.keys(details).length ? details : undefined);
}

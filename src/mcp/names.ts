/** Every MCP tool, in the order tools/list shows them. Kept apart from tools.ts so config.ts can validate names. */
export const TOOL_NAMES = [
  'spall_whoami',
  'spall_search',
  'spall_list',
  'spall_read',
  'spall_query_base',
  'spall_create',
  'spall_edit',
  'spall_move',
  'spall_trash',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export type { CodingToolName } from './coding-agent-loop';
/**
 * Tools exposed to Shelly's Coding Agent.
 *
 * This module defines the tool contract only. Actual execution must be
 * supplied by the caller through validated handlers so the coding agent
 * cannot bypass Shelly's workspace/security boundaries.
 */

import type {
  CodingAgentToolHandler,
  CodingToolCall,
  CodingToolName,
  CodingToolResult,
} from './coding-agent-loop';

export const CODING_AGENT_TOOLS: readonly CodingToolName[] = [
  'list_files',
  'read_file',
  'search_text',
  'write_file',
  'run_command',
  'git_diff',
] as const;

export const CODING_AGENT_TOOL_DESCRIPTIONS: Record<
  CodingToolName,
  string
> = {
  list_files:
    'List files and directories inside the authorized workspace.',
  read_file:
    'Read text from a file inside the authorized workspace.',
  search_text:
    'Search for text or patterns inside the authorized workspace.',
  write_file:
    'Write or replace a file inside the authorized workspace.',
  run_command:
    'Run a command inside the authorized workspace using Shelly security policy.',
  git_diff:
    'Show the current Git diff for the authorized workspace.',
};

export type CodingAgentToolRegistry = Partial<
  Record<CodingToolName, CodingAgentToolHandler>
>;

export function createCodingAgentToolRegistry(
  handlers: CodingAgentToolRegistry,
): CodingAgentToolRegistry {
  return {
    ...handlers,
  };
}

/**
 * Validates the shape of a model-produced tool call before dispatch.
 * This is deliberately strict: unknown tools are rejected instead of
 * being interpreted as arbitrary commands.
 */
export function validateCodingToolCall(
  value: unknown,
): value is CodingToolCall {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const call = value as Record<string, unknown>;

  if (
    typeof call.name !== 'string' ||
    !CODING_AGENT_TOOLS.includes(call.name as CodingToolName)
  ) {
    return false;
  }

  if (
    !call.arguments ||
    typeof call.arguments !== 'object' ||
    Array.isArray(call.arguments)
  ) {
    return false;
  }

  return true;
}

export function unavailableToolResult(
  call: CodingToolCall,
): CodingToolResult {
  return {
    ok: false,
    output: `Tool '${call.name}' is recognized but has no execution handler.`,
  };
}

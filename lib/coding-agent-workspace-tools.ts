/**
 * Workspace tools for Shelly Coding Agent.
 *
 * Read-only tools are implemented here.
 * Write/command execution remain behind Shelly's existing capability
 * and boundary systems and are not executed directly from this module.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type {
  CodingAgentToolRegistry,
  CodingToolName,
} from './coding-agent-tools';

const execFileAsync = promisify(execFile);

function resolveInsideWorkspace(
  workspaceRoot: string,
  requestedPath: string,
): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, requestedPath || '.');

  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('Path escapes the authorized workspace.');
  }

  return target;
}

async function listFiles(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  const target = resolveInsideWorkspace(workspaceRoot, requestedPath);
  const entries = await fs.readdir(target, { withFileTypes: true });

  return entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (entry) =>
        `${entry.isDirectory() ? '[DIR] ' : '[FILE] '}${entry.name}`,
    )
    .join('\n');
}

async function readFile(
  workspaceRoot: string,
  requestedPath: string,
): Promise<string> {
  const target = resolveInsideWorkspace(workspaceRoot, requestedPath);
  const stat = await fs.stat(target);

  if (!stat.isFile()) {
    throw new Error('Requested path is not a file.');
  }

  return fs.readFile(target, 'utf8');
}

async function searchText(
  workspaceRoot: string,
  pattern: string,
): Promise<string> {
  if (!pattern.trim()) {
    throw new Error('Search pattern cannot be empty.');
  }

  const { stdout } = await execFileAsync(
    'grep',
    [
      '-Rni',
      '--exclude-dir=.git',
      '--exclude-dir=node_modules',
      pattern,
      workspaceRoot,
    ],
    {
      maxBuffer: 4 * 1024 * 1024,
    },
  ).catch((error: any) => {
    if (error?.code === 1) {
      return { stdout: '' };
    }

    throw error;
  });

  return stdout.trim();
}

async function gitDiff(workspaceRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'git',
    ['-C', workspaceRoot, 'diff', '--'],
    {
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  return stdout.trim();
}

function argumentString(
  args: Record<string, unknown>,
  name: string,
): string {
  const value = args[name];

  if (typeof value !== 'string') {
    throw new Error(`Argument '${name}' must be a string.`);
  }

  return value;
}

export function createCodingAgentWorkspaceTools(
  workspaceRoot: string,
): CodingAgentToolRegistry {
  const tools: CodingAgentToolRegistry = {};

  tools.list_files = async (call) => ({
    ok: true,
    output: await listFiles(
      workspaceRoot,
      typeof call.arguments.path === 'string'
        ? call.arguments.path
        : '.',
    ),
  });

  tools.read_file = async (call) => ({
    ok: true,
    output: await readFile(
      workspaceRoot,
      argumentString(call.arguments, 'path'),
    ),
  });

  tools.search_text = async (call) => ({
    ok: true,
    output: await searchText(
      workspaceRoot,
      argumentString(call.arguments, 'pattern'),
    ),
  });

  tools.git_diff = async () => ({
    ok: true,
    output: await gitDiff(workspaceRoot),
  });

  /*
   * Write and command execution are intentionally NOT implemented here.
   *
   * The actual Shelly capability functions live inside the generated
   * agent-executor shell runtime:
   *
   *   cap_fs_write_file
   *   cap_workspace_exec
   *
   * They require the capability broker and workspace roots. The Coding Agent
   * loop must therefore receive adapters from the executor rather than
   * importing or duplicating those shell functions here.
   *
   * This keeps the model-facing tool layer unable to bypass Shelly's
   * existing security boundary.
   */

  return tools;
}

export const CODING_AGENT_READ_ONLY_TOOLS: readonly CodingToolName[] = [
  'list_files',
  'read_file',
  'search_text',
  'git_diff',
];

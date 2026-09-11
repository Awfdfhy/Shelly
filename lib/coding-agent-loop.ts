/**
 * Coding Agent Loop
 *
 * Model-agnostic orchestration loop:
 *
 *   Model -> tool request -> tool execution -> result -> Model -> ...
 *
 * This module intentionally does not bypass Shelly's existing security,
 * approval, filesystem, or workspace-boundary systems. Callers provide
 * validated tool handlers.
 */

export type CodingToolName =
  | 'list_files'
  | 'read_file'
  | 'search_text'
  | 'write_file'
  | 'run_command'
  | 'git_diff';

export type CodingToolCall = {
  name: CodingToolName;
  arguments: Record<string, unknown>;
};

export type CodingModelResponse = {
  text?: string;
  toolCall?: CodingToolCall;
  done?: boolean;
};

export type CodingToolResult = {
  ok: boolean;
  output: string;
};

export type CodingAgentMessage = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
};

export type CodingAgentToolHandler = (
  call: CodingToolCall,
) => Promise<CodingToolResult>;

export type CodingAgentModel = (
  messages: CodingAgentMessage[],
) => Promise<CodingModelResponse>;

export type CodingAgentOptions = {
  maxIterations?: number;
  onToolCall?: (
    call: CodingToolCall,
    result: CodingToolResult,
    iteration: number,
  ) => void | Promise<void>;
};

const DEFAULT_MAX_ITERATIONS = 30;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

/**
 * Runs a real iterative coding-agent conversation.
 *
 * The model is allowed to request one validated tool at a time.
 * Tool results are fed back into the model until it returns done/final text
 * or the iteration limit is reached.
 */
export async function runCodingAgentLoop(
  initialPrompt: string,
  model: CodingAgentModel,
  tools: Partial<Record<CodingToolName, CodingAgentToolHandler>>,
  options: CodingAgentOptions = {},
): Promise<string> {
  const maxIterations = Math.max(
    1,
    Math.min(options.maxIterations ?? DEFAULT_MAX_ITERATIONS, 100),
  );

  const messages: CodingAgentMessage[] = [
    {
      role: 'user',
      content: initialPrompt,
    },
  ];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const response = await model(messages);

    if (response.text) {
      messages.push({
        role: 'assistant',
        content: response.text,
      });
    }

    if (response.done || !response.toolCall) {
      return response.text?.trim() || 'Coding agent finished without a final response.';
    }

    const call = response.toolCall;
    const handler = tools[call.name];

    if (!handler) {
      const error = `Tool '${call.name}' is not available or not authorized.`;

      messages.push({
        role: 'tool',
        toolName: call.name,
        content: error,
      });

      continue;
    }

    let result: CodingToolResult;

    try {
      result = await handler(call);
    } catch (error) {
      result = {
        ok: false,
        output:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }

    await options.onToolCall?.(call, result, iteration);

    messages.push({
      role: 'tool',
      toolName: call.name,
      content: safeJson({
        ok: result.ok,
        output: result.output,
      }),
    });
  }

  return `Coding agent stopped after reaching the maximum of ${maxIterations} iterations.`;
}

/**
 * OpenAI-compatible model adapter for Shelly Coding Agent.
 *
 * Uses Shelly's existing OpenAI-compatible local endpoint.
 */

import type {
  CodingAgentMessage,
  CodingAgentModel,
  CodingModelResponse,
  CodingToolCall,
  CodingToolName,
} from './coding-agent-loop';

import {
  CODING_AGENT_TOOL_DESCRIPTIONS,
  CODING_AGENT_TOOLS,
} from './coding-agent-tools';

export type CodingAgentModelOptions = {
  endpoint: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
};

type OpenAIMessage = {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
};

function toOpenAIMessage(message: CodingAgentMessage): OpenAIMessage {
  return {
    role: message.role,
    content: message.content,
  };
}

function toolSchema(name: CodingToolName) {
  const properties: Record<string, unknown> = {};

  if (name === 'list_files') {
    properties.path = {
      type: 'string',
      description: 'Relative path inside the authorized workspace.',
    };
  }

  if (name === 'read_file') {
    properties.path = {
      type: 'string',
      description: 'Relative file path inside the authorized workspace.',
    };
  }

  if (name === 'search_text') {
    properties.pattern = {
      type: 'string',
      description: 'Text or regular expression to search for.',
    };
  }

  return {
    type: 'function',
    function: {
      name,
      description: CODING_AGENT_TOOL_DESCRIPTIONS[name],
      parameters: {
        type: 'object',
        properties,
        additionalProperties: false,
      },
    },
  };
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);

    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Invalid tool arguments are rejected by the loop/handler.
  }

  return {};
}

function normalizeToolCall(value: any): CodingToolCall | undefined {
  const fn = value?.function;

  if (
    !fn ||
    typeof fn.name !== 'string' ||
    !CODING_AGENT_TOOLS.includes(fn.name as CodingToolName)
  ) {
    return undefined;
  }

  return {
    name: fn.name as CodingToolName,
    arguments: parseArguments(fn.arguments),
  };
}

export function createOpenAICompatibleCodingModel(
  options: CodingAgentModelOptions,
): CodingAgentModel {
  return async (
    messages: CodingAgentMessage[],
  ): Promise<CodingModelResponse> => {
    const endpoint = options.endpoint.replace(/\/+$/, '');

    const response = await fetch(
      `${endpoint}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey
            ? { Authorization: `Bearer ${options.apiKey}` }
            : {}),
        },
        body: JSON.stringify({
          model: options.model,
          messages: messages.map(toOpenAIMessage),
          tools: CODING_AGENT_TOOLS.map(toolSchema),
          tool_choice: 'auto',
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 2048,
        }),
      },
    );

    if (!response.ok) {
      const body = await response.text();

      throw new Error(
        `Coding agent model request failed (${response.status}): ${body.slice(0, 1000)}`,
      );
    }

    const data: any = await response.json();
    const message = data?.choices?.[0]?.message;

    if (!message) {
      throw new Error('Coding agent model returned no message.');
    }

    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];

    const toolCall = normalizeToolCall(toolCalls[0]);

    if (toolCall) {
      return {
        text:
          typeof message.content === 'string'
            ? message.content
            : undefined,
        toolCall,
        done: false,
      };
    }

    return {
      text:
        typeof message.content === 'string'
          ? message.content.trim()
          : '',
      done: true,
    };
  };
}

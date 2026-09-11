#!/usr/bin/env node

import fs from 'node:fs';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function readJson(file, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function tools() {
  return [
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files and directories inside the authorized workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a text file inside the authorized workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' }
          },
          required: ['path'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_text',
        description: 'Search for text inside the authorized workspace.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string' }
          },
          required: ['pattern'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write or replace a file inside the authorized workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            content: { type: 'string' }
          },
          required: ['path', 'content'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a command inside the authorized workspace.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string' },
            cwd: { type: 'string' }
          },
          required: ['command'],
          additionalProperties: false
        }
      }
    },
    {
      type: 'function',
      function: {
        name: 'git_diff',
        description: 'Show the current Git diff.',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false
        }
      }
    }
  ];
}

async function modelRequest(state) {
  const endpoint = String(state.endpoint || '').replace(/\/+$/, '');
  const url = `${endpoint}/chat/completions`;

  const headers = {
    'Content-Type': 'application/json'
  };

  if (state.apiKey) {
    headers.Authorization = `Bearer ${state.apiKey}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: state.model,
      messages: state.messages,
      tools: tools(),
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: 4096
    })
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`Model request failed (${response.status}): ${body.slice(0, 2000)}`);
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`Model returned invalid JSON: ${body.slice(0, 1000)}`);
  }

  const message = data?.choices?.[0]?.message;

  if (!message) {
    throw new Error('Model returned no message.');
  }

  return message;
}

async function init() {
  const stateFile = arg('state');
  const prompt = arg('prompt');
  const system = arg('system');
  const workspace = arg('workspace');
  const model = arg('model');

  // Shelly already stores provider credentials in the agent environment.
  // Prefer explicit Coding Agent values, then fall back to the same provider
  // credentials Shelly's existing agent executor uses.
  const envEndpoint =
    process.env.CODING_AGENT_ENDPOINT ||
    process.env.OPENAI_BASE_URL ||
    process.env.OPENROUTER_BASE_URL ||
    (process.env.GROQ_API_KEY ? 'https://api.groq.com/openai/v1' : '') ||
    (process.env.CEREBRAS_API_KEY ? 'https://api.cerebras.ai/v1' : '');

  const endpoint = arg('endpoint', envEndpoint);

  const apiKey =
    arg('api-key') ||
    process.env.CODING_AGENT_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.OPENROUTER_API_KEY ||
    process.env.GROQ_API_KEY ||
    process.env.CEREBRAS_API_KEY ||
    '';

  if (!stateFile || !prompt || !model || !endpoint) {
    throw new Error(
      'Missing Coding Agent runtime configuration. Set CODING_AGENT_ENDPOINT or configure an OpenAI-compatible provider in Shelly.'
    );
  }

  const messages = [];

  if (system) {
    let systemText = system;

    try {
      const parsed = JSON.parse(system);
      if (typeof parsed === 'string') systemText = parsed;
    } catch {}

    messages.push({
      role: 'system',
      content:
        `${systemText}\n\n` +
        `You are Shelly's Coding Agent. Work only inside the authorized workspace.\n` +
        `Authorized workspace: ${workspace}\n` +
        `Use tools to inspect the project before editing it.\n` +
        `After changes, run appropriate checks when possible.\n` +
        `Do not claim success unless the relevant check actually succeeds.`
    });
  }

  messages.push({
    role: 'user',
    content: prompt
  });

  writeJson(stateFile, {
    version: 1,
    workspace,
    model,
    endpoint,
    apiKey,
    messages
  });
}

async function step() {
  const stateFile = arg('state');
  const responseFile = arg('response');

  const state = readJson(stateFile);

  if (!state.messages || !Array.isArray(state.messages)) {
    throw new Error('Coding Agent state is invalid.');
  }

  try {
    const message = await modelRequest(state);

    const text =
      typeof message.content === 'string'
        ? message.content
        : '';

    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];

    if (calls.length > 0) {
      const call = calls[0];
      const name = call?.function?.name;
      let argumentsValue = {};

      try {
        argumentsValue = JSON.parse(call?.function?.arguments || '{}');
      } catch {
        argumentsValue = {};
      }

      state.messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: calls
      });

      writeJson(stateFile, state);

      writeJson(responseFile, {
        kind: 'tool_call',
        text,
        tool: name,
        arguments: argumentsValue,
        toolCallId: call?.id || ''
      });

      return;
    }

    state.messages.push({
      role: 'assistant',
      content: text
    });

    writeJson(stateFile, state);

    writeJson(responseFile, {
      kind: 'final',
      text
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);

    writeJson(responseFile, {
      kind: 'error',
      text
    });
  }
}

function addToolResult() {
  const stateFile = arg('state');
  const resultFile = arg('file');
  const ok = arg('ok') === '1';

  const state = readJson(stateFile);
  const result = fs.existsSync(resultFile)
    ? fs.readFileSync(resultFile, 'utf8')
    : '';

  const lastAssistant = [...state.messages]
    .reverse()
    .find(message => Array.isArray(message.tool_calls));

  const call = lastAssistant?.tool_calls?.[0];

  state.messages.push({
    role: 'tool',
    tool_call_id: call?.id || '',
    content: JSON.stringify({
      ok,
      output: result.slice(0, 12000)
    })
  });

  writeJson(stateFile, state);
}

function field() {
  const file = arg('file');
  const name = arg('field');
  const value = readJson(file);

  if (name === 'arguments') {
    process.stdout.write(JSON.stringify(value.arguments || {}));
    return;
  }

  const result = value?.[name];

  if (typeof result === 'string') {
    process.stdout.write(result);
  } else if (result !== undefined) {
    process.stdout.write(JSON.stringify(result));
  }
}

function objectArg() {
  const json = arg('json');
  const name = arg('field');

  let value = {};

  try {
    value = JSON.parse(json);
  } catch {}

  const result = value?.[name];

  if (typeof result === 'string') {
    process.stdout.write(result);
  } else if (result !== undefined) {
    process.stdout.write(JSON.stringify(result));
  }
}

const command = process.argv[2];

try {
  if (command === 'init') {
    await init();
  } else if (command === 'step') {
    await step();
  } else if (command === 'result') {
    addToolResult();
  } else if (command === 'field') {
    field();
  } else if (command === 'arg') {
    objectArg();
  } else {
    throw new Error(`Unknown runtime command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

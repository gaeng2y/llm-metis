import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAnthropicState } from '../dist/anthropic.js';

const tool = { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };
const request = () => ({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'Read package.json' }], tools: [tool], output_config: { effort: 'high' } });

test('Anthropic extraction retains public context and tool schemas without private content blocks', () => {
  const body = request();
  body.system = [{ type: 'text', text: 'Only inspect files.', cache_control: { type: 'ephemeral' } }];
  body.messages.push({ role: 'assistant', content: [
    { type: 'thinking', thinking: 'private reasoning', signature: 'private signature' },
    { type: 'redacted_thinking', data: 'private encrypted payload' },
    { type: 'text', text: 'I will read the file.' },
    { type: 'tool_use', id: 'tool_1', name: 'Read', input: { path: 'package.json' } },
  ] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: [
    { type: 'text', text: '{"name":"llm-metis"}' },
    { type: 'image', source: { type: 'base64', data: 'private image bytes' } },
  ] }] });
  const original = JSON.stringify(body);
  const state = extractAnthropicState(body);
  assert.equal(state.userTask, 'Read package.json');
  assert.equal(state.instructions, 'Only inspect files.');
  assert.equal(state.currentEffort, 'high');
  assert.equal(state.nativeEffort, false);
  assert.equal(state.availableTools[0].forceable, true);
  assert.deepEqual(state.availableTools[0].parameters, tool.input_schema);
  assert.deepEqual(state.recentToolCalls, [
    { type: 'function_call', name: 'Read', callId: 'tool_1', arguments: '{"path":"package.json"}', output: undefined },
    { type: 'function_call_output', name: undefined, callId: 'tool_1', arguments: undefined, output: '{"name":"llm-metis"}' },
  ]);
  assert.doesNotMatch(JSON.stringify(state), /private|signature|base64/);
  assert.equal(JSON.stringify(body), original);
});

test('Anthropic extraction preserves caller constraints and skips incomplete history', () => {
  assert.equal(extractAnthropicState({ ...request(), tool_choice: { type: 'auto', disable_parallel_tool_use: true } }).toolChoice, 'auto');
  for (const choice of [{ type: 'tool', name: 'Read' }, { type: 'none' }, null]) {
    assert.deepEqual(extractAnthropicState({ ...request(), tool_choice: choice }).toolChoice, choice);
  }
  assert.notEqual(extractAnthropicState({ ...request(), tool_choice: 'auto' }).toolChoice, 'auto');
  assert.equal(extractAnthropicState({ ...request(), output_config: {} }).nativeEffort, true);
  assert.equal(extractAnthropicState({ ...request(), messages: [{ role: 'system', content: [], output_config: { effort: 'low' } }] }).nativeEffort, true);
  assert.equal(extractAnthropicState({ ...request(), messages: [{ role: 'assistant', content: [{ type: 'compaction', content: 'opaque context' }] }] }).incompleteHistory, true);
  assert.equal(extractAnthropicState({ ...request(), messages: 'opaque context' }).incompleteHistory, true);
  const long = extractAnthropicState({ ...request(), messages: [{ role: 'user', content: 'a'.repeat(10000) }] });
  assert.equal(long.truncated, true);
  assert.ok(long.userTask.length < 6100);
});

test('Anthropic forcing is limited to known models, ordinary tools and compatible thinking', () => {
  for (const thinking of [{ type: 'enabled', budget_tokens: 2048 }, { type: 'adaptive' }, null]) {
    assert.equal(extractAnthropicState({ ...request(), thinking }).availableTools[0].forceable, false);
  }
  assert.equal(extractAnthropicState({ ...request(), thinking: { type: 'disabled' } }).availableTools[0].forceable, true);
  assert.equal(extractAnthropicState({ ...request(), model: 'claude-opus-4-5-20251101' }).availableTools[0].forceable, true);
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'alias', 'claude-sonnet-4-60']) {
    assert.equal(extractAnthropicState({ ...request(), model }).availableTools[0].forceable, false);
  }
  for (const tools of [
    [{ ...tool, type: 'web_search_20250305' }], [{ ...tool, defer_loading: true }],
    [{ ...tool, allowed_callers: ['code_execution_20250825'] }], [{ ...tool, input_schema: undefined }], [tool, tool],
  ]) assert.equal(extractAnthropicState({ ...request(), tools }).availableTools[0].forceable, false);
});

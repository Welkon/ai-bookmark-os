import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// 回归：推理模型（deepseek-flash / deepseek-reasoner）在小 token 预算下只返回
// reasoning_content、content 为空，诊断不得因此报“不符合协议”。

const source = readFileSync('src/timeline/pages/settings/settings.js', 'utf8');
const start = source.indexOf('function parseTreeTestResponse(');
const end = source.indexOf('function treeTestRetryDelayMs(', start);
assert.ok(start >= 0 && end > start, 'settings.js should expose parseTreeTestResponse');

const context = { Error, JSON, String };
vm.createContext(context);
vm.runInContext(`${source.slice(start, end)}; this.parse = parseTreeTestResponse;`, context);
const parseTreeTestResponse = context.parse;

// 1) 常规 OpenAI 兼容响应
// vm 里创建的对象原型来自另一个 realm，这里逐字段断言
{
  const result = parseTreeTestResponse('openai', JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
  assert.equal(result.ok, true);
  assert.equal(result.sample, 'OK');
}

// 2) 推理模型：content 为空、只有 reasoning_content（实测 deepseek-flash + max_tokens 32）
{
  const payload = JSON.stringify({
    choices: [{ message: { content: '', reasoning_content: '用户要求回复 OK，直接回 OK。' }, finish_reason: 'length' }],
  });
  const result = parseTreeTestResponse('openai', payload);
  assert.equal(result.ok, true, 'reasoning_content 非空时不得判为不兼容');
  assert.equal(result.sample, '用户要求回复 OK，直接回 OK。');
}

// 3) content 为空白字符也要回退
{
  const payload = JSON.stringify({ choices: [{ message: { content: '   ', reasoning_content: 'thinking' } }] });
  const result = parseTreeTestResponse('openai', payload);
  assert.equal(result.ok, true);
  assert.equal(result.sample, 'thinking');
}

// 4) 两者都为空 → 仍然报错
assert.equal(
  parseTreeTestResponse('openai', JSON.stringify({ choices: [{ message: { content: '', reasoning_content: '' } }] })).ok,
  false,
);

// 5) 其它协议不受影响
{
  const result = parseTreeTestResponse('anthropic', JSON.stringify({ content: [{ type: 'text', text: 'OK' }] }));
  assert.equal(result.ok, true);
  assert.equal(result.sample, 'OK');
}
{
  const result = parseTreeTestResponse('gemini', JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }));
  assert.equal(result.ok, true);
  assert.equal(result.sample, 'OK');
}

// 6) 错误响应与非 JSON
{
  const failed = parseTreeTestResponse('openai', JSON.stringify({ error: { message: 'Model Not Exist' } }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /Model Not Exist/);
  assert.equal(parseTreeTestResponse('openai', '<html>nope</html>').ok, false);
}

console.log('ai tree test response tests passed');

import assert from 'node:assert/strict';
import { build } from 'esbuild';

// 回归：deepseek-flash / deepseek-reasoner 这类推理模型的思考同样计入 max_tokens。
// 预算被思考吃光时 finish_reason=length、content 为空、reasoning_content 有内容，
// 旧实现直接抛 “API 返回内容为空”，用户只看到「分类失败：API 返回内容为空」。
// 现在必须自动提高 max_tokens 重试，并把真正原因写进错误信息。

async function importTypeScript(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

const nativeSetTimeout = globalThis.setTimeout;
const nativeClearTimeout = globalThis.clearTimeout;
globalThis.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, Math.min(Number(delay) || 0, 2), ...args);
globalThis.clearTimeout = (timer) => nativeClearTimeout(timer);

const { chat } = await importTypeScript('src/core/llm.ts');

const settings = {
  provider: 'custom',
  customApiStyle: 'openai',
  customFullUrl: true,
  baseUrl: 'https://api.test/chat',
  apiKey: 'test-key',
  model: 'deepseek-flash',
  aiRetryCount: 1,
  aiRequestTimeoutSeconds: 30,
};

const truncated = (reasoningTokens) =>
  JSON.stringify({
    choices: [{ message: { content: '', reasoning_content: 'x'.repeat(50) }, finish_reason: 'length' }],
    usage: { completion_tokens_details: { reasoning_tokens: reasoningTokens } },
  });
const answered = (content) => JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const geminiAnswered = (text) =>
  JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });

const sentBodies = [];
const stubFetch = (responses) => {
  let call = 0;
  globalThis.fetch = async (_url, options) => {
    sentBodies.push(JSON.parse(options.body));
    const body = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { status: 200, ok: true, text: async () => body };
  };
};

// 1) 预算被思考吃光 → 自动提高 max_tokens 重试并成功
{
  sentBodies.length = 0;
  stubFetch([truncated(4096), answered('{"tree":[]}')]);
  const retries = [];
  const content = await chat(settings, [{ role: 'user', content: '建树' }], {
    maxTokens: 4096,
    onRetry: (info) => retries.push(info),
  });
  assert.equal(content, '{"tree":[]}');
  assert.deepEqual(sentBodies.map((body) => body.max_tokens), [4096, 8192], '第二次请求应把预算翻倍');
  assert.equal(retries.length, 1, '加码重试要上报进度，避免界面静默等待');
  assert.match(retries[0].reason, /推理模型的思考用尽了输出预算/);
  assert.match(retries[0].reason, /max_tokens 到 8192/);
}

// 2) 一直截断 → 加码到 32768 封顶后给出可执行的错误，而不是“返回内容为空”
{
  sentBodies.length = 0;
  stubFetch([truncated(8192)]);
  await assert.rejects(
    () => chat(settings, [{ role: 'user', content: '建树' }], { maxTokens: 8192 }),
    (error) => {
      assert.match(error.message, /推理模型的思考用尽了输出预算/);
      assert.match(error.message, /reasoning_tokens=8192/);
      assert.match(error.message, /max_tokens=32768/, '错误信息要说明最终预算');
      return true;
    },
  );
  assert.deepEqual(sentBodies.map((body) => body.max_tokens), [8192, 16384, 32768], '最多加码两次到 32768 封顶');
}

// 3) gemini 风格的预算字段是 maxOutputTokens，同样要能被读取和加码
{
  sentBodies.length = 0;
  stubFetch([JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }] }), geminiAnswered('OK')]);
  const gemini = { provider: 'gemini', apiKey: 'k', model: 'gemini-flash', aiRetryCount: 1, aiRequestTimeoutSeconds: 30 };
  assert.equal(await chat(gemini, [{ role: 'user', content: '建树' }], { maxTokens: 4096 }), 'OK');
  assert.deepEqual(sentBodies.map((body) => body.generationConfig.maxOutputTokens), [4096, 8192]);
  assert.equal(sentBodies[0].max_tokens, undefined, 'gemini 请求体不应出现 max_tokens');
}

// 4) 正常回复不触发加码，请求体预算保持调用方给的值
{
  sentBodies.length = 0;
  stubFetch([answered('OK')]);
  assert.equal(await chat(settings, [{ role: 'user', content: 'hi' }], { maxTokens: 2048 }), 'OK');
  assert.deepEqual(sentBodies.map((body) => body.max_tokens), [2048]);
}

// 5) 网关返回空内容（未截断）仍沿用原提示，改动不掩盖真实故障
{
  sentBodies.length = 0;
  stubFetch([JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })]);
  await assert.rejects(
    () => chat(settings, [{ role: 'user', content: 'hi' }], { maxTokens: 2048 }),
    /API 返回内容为空/,
  );
  assert.deepEqual(sentBodies.map((body) => body.max_tokens), [2048, 4096, 8192], '空回复先加码再放弃');
}

console.log('ai output budget tests passed');

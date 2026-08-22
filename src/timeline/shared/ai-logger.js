// ===== AI 辅助分类日志 =====
// 轻量日志记录，用于排查 AI 分类触发、成功、失败、回填等问题

const AI_LOGS_KEY = 'ai_classifier_logs';
const AI_MAX_LOGS = 500;

function _getDomainFromUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || '';
  }
}

async function getAILogs(limit = 100) {
  try {
    const data = await chrome.storage.local.get(AI_LOGS_KEY);
    const logs = data[AI_LOGS_KEY] || [];
    return logs.slice(-limit).reverse();
  } catch (e) {
    return [];
  }
}

// 串行化日志读改写：同一次分类的 trigger/classify_* 等日志会并发写入，
// 此前 get→push→set 无队列，后写者会覆盖先写者导致丢条。单 key 用一条链即可。
let logWriteChain = Promise.resolve();

function enqueueLogWrite(task) {
  const run = logWriteChain.then(task, task);
  // 链上吞掉错误：一次失败不能让后续日志写入全部短路。
  logWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

async function logAIEvent(event) {
  try {
    if (!event || !event.type) return null;
    const entry = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
      type: event.type || 'unknown',
      provider: event.provider || '',
      model: event.model || '',
      domain: event.domain || (event.url ? _getDomainFromUrl(event.url) : ''),
      duration: typeof event.duration === 'number' ? event.duration : undefined,
      success: event.success,
      error: event.error,
      details: event.details || {}
    };

    await enqueueLogWrite(async () => {
      const data = await chrome.storage.local.get(AI_LOGS_KEY);
      const logs = data[AI_LOGS_KEY] || [];
      logs.push(entry);
      if (logs.length > AI_MAX_LOGS) {
        logs.splice(0, logs.length - AI_MAX_LOGS);
      }
      await chrome.storage.local.set({ [AI_LOGS_KEY]: logs });
      notifyAILogUpdate();
    });
    return entry;
  } catch (e) {
    console.warn('AI log failed:', e);
    return null;
  }
}

async function notifyAILogUpdate() {
  try {
    await chrome.runtime.sendMessage({ action: 'aiLogUpdated' }).catch(() => {});
  } catch (e) {
    // ignore
  }
}

async function clearAILogs() {
  try {
    await chrome.storage.local.remove(AI_LOGS_KEY);
    return true;
  } catch (e) {
    return false;
  }
}

async function getAILogStats() {
  try {
    const data = await chrome.storage.local.get(AI_LOGS_KEY);
    const logs = data[AI_LOGS_KEY] || [];
    const total = logs.length;
    const triggered = logs.filter(l => l.type === 'trigger').length;
    const success = logs.filter(l => l.type === 'classify_success').length;
    const fail = logs.filter(l => l.type === 'classify_fail').length;
    const cacheHit = logs.filter(l => l.type === 'cache_hit').length;
    const backfillSuccess = logs.filter(l => l.type === 'backfill_success').length;
    const backfillFail = logs.filter(l => l.type === 'backfill_fail').length;
    const latencies = logs
      .filter(l => typeof l.duration === 'number' && l.duration > 0)
      .map(l => l.duration);
    const avgDuration = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0;
    // 每次 classifyWithAI 都先写一条 trigger 日志，缓存命中时再补一条 cache_hit，
    // 因此 triggered 已覆盖全部调用次数；把 cacheHit 也算进分母会让同一次调用计两遍，
    // 命中率上限只能到 0.5。
    const cacheHitRate = triggered > 0 ? Math.min(1, cacheHit / triggered) : 0;
    return { total, triggered, success, fail, cacheHit, cacheHitRate, backfillSuccess, backfillFail, avgDuration };
  } catch (e) {
    return { total: 0, triggered: 0, success: 0, fail: 0, cacheHit: 0, cacheHitRate: 0, backfillSuccess: 0, backfillFail: 0, avgDuration: 0 };
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getAILogs, logAIEvent, clearAILogs, getAILogStats };
}

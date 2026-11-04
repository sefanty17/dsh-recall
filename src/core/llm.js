/**
 * src/core/llm.js
 *
 * L2 抽取用的最小模型客户端（OpenAI 兼容接口）。
 *
 * 接口：
 *   resolveLlmConfig(env = process.env) -> { apiKey, baseUrl, model, available }
 *   chatJson({ messages, apiKey, baseUrl, model, timeoutMs, maxRetries }) -> object
 *
 * 安全：
 *   - 密钥只从环境变量 / ~/.dsh/.credentials.yaml 读取，绝不打印、绝不写库。
 *   - 所有对外错误信息先经过 redactSecrets()，把 sk- 开头的串替换成 <redacted>。
 *
 * 依赖：只用全局 fetch（Node >= 22.19），不引入任何 npm 包。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_MODEL = 'deepseek-chat';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_ERROR_DETAIL = 300;

// ---------------------------------------------------------------------------
// 密钥与配置
// ---------------------------------------------------------------------------

/** 把错误信息/响应体里的 sk- 密钥替换掉。导出给脚本和抽取层复用。 */
export function redactSecrets(text) {
  if (text === null || text === undefined) return '';
  return String(text).replace(/sk-[A-Za-z0-9_-]+/g, '<redacted>');
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

function expandHome(input) {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return join(homedir(), input.slice(2));
  return input;
}

/** 去掉 YAML 标量外层的引号（只处理成对的首尾引号）。 */
function stripQuotes(value) {
  const text = value.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

/**
 * 极简 YAML 读取：只取顶层 refs 下的 key: value。
 * 不引入 yaml 依赖，也不尝试兼容完整 YAML 语法；解析失败一律当作没有凭据。
 */
function parseCredentialRefs(text) {
  const refs = {};
  let section = null;
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const top = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (top) {
      section = top[1];
      continue;
    }
    if (section !== 'refs') continue;

    const entry = /^\s+([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!entry) continue;
    let value = entry[2].trim();
    // 未加引号的值允许行尾注释（" # ..."）
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    refs[entry[1]] = stripQuotes(value);
  }
  return refs;
}

function credentialsPath(env) {
  const override = firstNonEmpty(env?.DSH_RECALL_CREDENTIALS);
  return override ? expandHome(override) : join(homedir(), '.dsh', '.credentials.yaml');
}

/** 读 refs.DEEPSEEK_API_KEY；支持字面量与 env:NAME 两种形式。任何异常都吞掉。 */
function readCredentialRef(env, name) {
  let refs;
  try {
    refs = parseCredentialRefs(readFileSync(credentialsPath(env), 'utf8'));
  } catch {
    return null;
  }
  const raw = refs[name];
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const value = raw.trim();
  if (value.startsWith('env:')) {
    const variable = value.slice(4).trim();
    return variable ? firstNonEmpty(env?.[variable]) : null;
  }
  return value;
}

/**
 * 解析模型配置。没有凭据时返回 available=false，不抛异常。
 * @param {NodeJS.ProcessEnv|Record<string,string>} [env]
 * @returns {{ apiKey: string|null, baseUrl: string, model: string, available: boolean }}
 */
export function resolveLlmConfig(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  let apiKey = firstNonEmpty(source.DSH_RECALL_API_KEY, source.DEEPSEEK_API_KEY);
  if (!apiKey) apiKey = readCredentialRef(source, 'DEEPSEEK_API_KEY');

  const baseUrl = (firstNonEmpty(source.DSH_RECALL_BASE_URL, source.DEEPSEEK_BASE_URL)
    || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = firstNonEmpty(source.DSH_RECALL_MODEL, source.DEEPSEEK_MODEL) || DEFAULT_MODEL;

  return { apiKey: apiKey || null, baseUrl, model, available: Boolean(apiKey) };
}

// ---------------------------------------------------------------------------
// JSON 解析
// ---------------------------------------------------------------------------

/** 去掉 ```json ... ``` 围栏；没有围栏时原样返回。 */
function stripFence(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  const firstBreak = trimmed.indexOf('\n');
  if (firstBreak === -1) return trimmed.slice(3).replace(/```\s*$/, '').trim();
  return trimmed.slice(firstBreak + 1).replace(/```\s*$/, '').trim();
}

function parseJsonObject(content) {
  const attempts = [content.trim()];
  const fenced = stripFence(content);
  if (fenced !== attempts[0]) attempts.push(fenced);
  const open = content.indexOf('{');
  const close = content.lastIndexOf('}');
  if (open !== -1 && close > open) attempts.push(content.slice(open, close + 1));

  for (const candidate of attempts) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // 试下一种候选
    }
  }

  const preview = redactSecrets(content.slice(0, 200)).replace(/\s+/g, ' ');
  throw new Error(`chatJson: 模型返回无法解析为 JSON（开头：${preview}）`);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

/** 指数退避：400ms、800ms、1600ms…，上限 4s。 */
function backoffMs(attempt) {
  return Math.min(4000, 400 * (2 ** attempt));
}

function timeoutError(timeoutMs) {
  return new Error(`chatJson: 请求超时（${timeoutMs}ms）`);
}

function networkError(err, timeoutMs) {
  const name = err?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return timeoutError(timeoutMs);
  const reason = err?.cause?.message ?? err?.message ?? String(err);
  return new Error(`chatJson: 网络错误 — ${redactSecrets(reason)}`);
}

async function safeReadText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/**
 * 调一次 JSON 输出模式的 chat completion，返回解析后的 JS 对象。
 *
 * - OpenAI 兼容：POST {baseUrl}/chat/completions
 * - temperature=0，response_format={type:'json_object'}
 * - 429 / 5xx / 网络错误重试（指数退避）；其他 4xx 立即失败
 * - 模型返回带 ```json 围栏时自动剥壳
 *
 * @param {{
 *   messages: Array<{role: string, content: string}>,
 *   apiKey: string,
 *   baseUrl?: string,
 *   model?: string,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   fetchImpl?: typeof fetch,
 * }} options
 * @returns {Promise<object>}
 */
export async function chatJson(options = {}) {
  const {
    messages,
    apiKey,
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    fetchImpl = globalThis.fetch,
  } = options;

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    throw new Error('chatJson: 缺少 apiKey（请检查 DSH_RECALL_API_KEY / DEEPSEEK_API_KEY）');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('chatJson: messages 不能为空');
  }
  if (typeof fetchImpl !== 'function') {
    throw new Error('chatJson: 当前运行环境没有 fetch');
  }

  const url = `${String(baseUrl).replace(/\/+$/, '')}/chat/completions`;
  const body = JSON.stringify({
    model,
    messages,
    temperature: 0,
    stream: false,
    response_format: { type: 'json_object' },
  });
  const retries = Number.isInteger(maxRetries) && maxRetries >= 0
    ? maxRetries
    : DEFAULT_MAX_RETRIES;
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      if (attempt >= retries) throw networkError(err, timeout);
      await sleep(backoffMs(attempt));
      continue;
    }

    if (!response.ok) {
      const detail = redactSecrets(await safeReadText(response))
        .replace(/\s+/g, ' ')
        .slice(0, MAX_ERROR_DETAIL);
      const error = new Error(
        `chatJson: HTTP ${response.status}${detail ? ` — ${detail}` : ''}`,
      );
      if (!isRetryableStatus(response.status) || attempt >= retries) throw error;
      await sleep(backoffMs(attempt));
      continue;
    }

    let payload;
    try {
      payload = await response.json();
    } catch (err) {
      throw new Error(`chatJson: 响应不是合法 JSON — ${redactSecrets(err?.message ?? err)}`);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error('chatJson: 响应缺少 choices[0].message.content');
    }
    return parseJsonObject(content);
  }
}

export default { resolveLlmConfig, chatJson, redactSecrets };

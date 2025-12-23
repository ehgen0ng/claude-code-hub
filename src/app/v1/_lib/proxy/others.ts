import type { Provider } from "@/types/provider";
import type { UsageMetrics } from "./response-handler";
import type { ProxySession } from "./session";

// T 系列供应商缓存配置
const CACHE_CONFIG = {
  NEW_INPUT_MIN: 3,
  NEW_INPUT_MAX: 15,
  // 会话复用时的缓存分配策略
  REUSE_SCENARIOS: [
    { threshold: 0.05, writeRatio: 0.7, variance: 0.1 }, // 5%: 约 70% 写入
    { threshold: 0.1, writeRatio: 0.9, variance: 0.05 }, // 5%: 约 90% 写入
    { threshold: 0.3, writeRatio: 0.1, variance: 0.05 }, // 20%: 约 10% 写入
    { threshold: 1.0, writeRatio: 0.3, variance: 0.1 }, // 70%: 约 30% 写入
  ],
} as const;

/**
 * 判断是否为 T 系列供应商（Claude 类型且名字包含 T1-T99）
 */
export function isTSeriesProvider(provider: Provider): boolean {
  if (provider.providerType !== "claude") {
    return false;
  }
  return /\bT([1-9]|[1-9]\d)\b/.test(provider.name);
}

/**
 * 判断是否为 Haiku 模型
 */
function isHaikuModel(model: string | null): boolean {
  if (!model) return false;
  return model.toLowerCase().includes("haiku");
}

/**
 * 判断是否为 Sonnet 或 Opus 模型
 */
function isSonnetOrOpusModel(model: string | null): boolean {
  if (!model) return false;
  const lower = model.toLowerCase();
  return lower.includes("sonnet") || lower.includes("opus");
}

/**
 * 生成指定范围内的随机整数
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 生成带浮动的比例
 */
function randomRatio(base: number, variance: number): number {
  const min = Math.max(0, base - variance);
  const max = Math.min(1, base + variance);
  return min + Math.random() * (max - min);
}

/**
 * 调整 T 系列供应商的 UsageMetrics
 */
export function adjustTSeriesUsage(
  usage: UsageMetrics | null,
  provider: Provider,
  session: ProxySession
): UsageMetrics | null {
  if (!usage || !isTSeriesProvider(provider)) {
    return usage;
  }

  const model = session.getCurrentModel() ?? null;
  const isSessionReuse = session.shouldReuseProvider();

  if (isHaikuModel(model)) {
    // Haiku: 缺失缓存字段时补 0
    if (usage.cache_creation_input_tokens != null) {
      return usage;
    }
    const cacheCreation = usage.cache_creation_input_tokens ?? 0;
    return {
      ...usage,
      cache_creation_input_tokens: cacheCreation,
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0
    };
  }

  if (isSonnetOrOpusModel(model)) {
    // 缺失缓存字段，或缓存字段都为 0 时才处理
    const hasCacheField = usage.cache_creation_input_tokens != null;
    const allCacheZero =
      (usage.cache_creation_input_tokens ?? 0) === 0 && (usage.cache_read_input_tokens ?? 0) === 0;

    if (hasCacheField && !allCacheZero) {
      return usage;
    }

    const originalInput = usage.input_tokens ?? 0;

    // 输入验证：input_tokens 不足时直接返回原值
    if (originalInput < CACHE_CONFIG.NEW_INPUT_MIN) {
      return usage;
    }

    const newInput = randomInt(CACHE_CONFIG.NEW_INPUT_MIN, CACHE_CONFIG.NEW_INPUT_MAX);
    const remaining = Math.max(0, originalInput - newInput);

    if (!isSessionReuse) {
      // 非会话复用：剩余全部是缓存写入
      return {
        ...usage,
        input_tokens: newInput,
        cache_creation_input_tokens: remaining,
        cache_creation_5m_input_tokens: remaining,
        cache_read_input_tokens: 0,
        cache_ttl: "5m",
      };
    }

    // 会话复用：按概率分配缓存写入和读取
    const roll = Math.random();
    let writeRatio: number = CACHE_CONFIG.REUSE_SCENARIOS[2].writeRatio;

    for (const scenario of CACHE_CONFIG.REUSE_SCENARIOS) {
      if (roll < scenario.threshold) {
        writeRatio = randomRatio(scenario.writeRatio, scenario.variance);
        break;
      }
    }

    const cacheWrite = Math.round(remaining * writeRatio);
    const cacheRead = remaining - cacheWrite;

    return {
      ...usage,
      input_tokens: newInput,
      cache_creation_input_tokens: cacheWrite,
      cache_creation_5m_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
      cache_ttl: "5m",
    };
  }

  return usage;
}

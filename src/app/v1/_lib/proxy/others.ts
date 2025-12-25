import type { Provider } from "@/types/provider";
import type { UsageMetrics } from "./response-handler";
import type { ProxySession } from "./session";
import { getRedisClient } from "@/lib/redis/client";
import { logger } from "@/lib/logger";

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
      cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
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

// =============== 供应商 User ID 池管理 ===============
// Redis 数据结构：
//   - user_pool:*:ids      ZSET  存储 user_id 池
//   - user_pool:*:bindings HASH  存储 session->user_id 绑定关系
// 查看所有绑定关系：
//   for key in $(redis-cli KEYS "user_pool:*:bindings"); do echo "=== $key ==="; redis-cli HGETALL "$key"; done

const USER_POOL_CONFIG = {
  POOL_MAX_SIZE: 3,
  TTL_MS: 30 * 60 * 1000, // 30 分钟（毫秒）
  TTL_SECONDS: 30 * 60, // 30 分钟（秒）
  PROVIDER_NAME_PATTERN: "Nono", // 触发条件：供应商名字包含此字符串
  USER_AGENT: "claude-cli/2.0.71 (external, cli)", // 覆盖的 User-Agent
} as const;

/**
 * 判断是否需要启用 user_id 池管理
 */
function shouldApplyUserIdPool(provider: Provider): boolean {
  return provider.name.includes(USER_POOL_CONFIG.PROVIDER_NAME_PATTERN);
}

/**
 * 获取供应商的 User-Agent 覆盖值
 * 如果供应商需要特殊的 User-Agent，返回覆盖值；否则返回 null
 */
export function getUserAgentOverride(provider: Provider): string | null {
  if (shouldApplyUserIdPool(provider)) {
    return USER_POOL_CONFIG.USER_AGENT;
  }
  return null;
}

/**
 * 从请求中提取 metadata.user_id
 */
function extractMetadataUserId(requestMessage: Record<string, unknown>): string | null {
  const metadata = requestMessage.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }

  const metadataObj = metadata as Record<string, unknown>;
  const userId = metadataObj.user_id;

  if (typeof userId === "string" && userId.length > 0) {
    return userId;
  }

  return null;
}

/**
 * 简单哈希函数（用于 session 到池索引的映射）
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // 转换为 32 位整数
  }
  return Math.abs(hash);
}

/**
 * 从 Redis 池中获取或映射 user_id
 *
 * 逻辑：
 * 1. 清理过期数据
 * 2. 优先复用：如果请求的 user_id 已在池中，直接返回
 * 3. 尝试收集：池未满时添加新 user_id
 * 4. 兜底映射：池已满时用 hash(sessionId) 映射
 */
async function getUserIdFromPool(
  providerId: number,
  sessionId: string,
  currentUserId: string | null
): Promise<string | null> {
  const redis = getRedisClient();
  if (!redis || redis.status !== "ready") {
    logger.debug("UserIdPool: Redis not ready, skipping", { providerId });
    return null;
  }

  const poolKey = `user_pool:${providerId}:ids`;
  const bindingsKey = `user_pool:${providerId}:bindings`;
  const now = Date.now();
  const expireThreshold = now - USER_POOL_CONFIG.TTL_MS;

  try {
    // 1. 清理过期数据
    await redis.zremrangebyscore(poolKey, "-inf", expireThreshold);

    // 2. 获取当前池中所有 user_id
    const members = await redis.zrange(poolKey, 0, -1);

    // 3. 优先复用：如果请求的 user_id 已在池中
    if (currentUserId && members.includes(currentUserId)) {
      // 刷新过期时间
      await redis.zadd(poolKey, now, currentUserId);
      await redis.expire(poolKey, USER_POOL_CONFIG.TTL_SECONDS);
      // 记录绑定关系
      await redis.hset(bindingsKey, sessionId, currentUserId);
      await redis.expire(bindingsKey, USER_POOL_CONFIG.TTL_SECONDS);

      logger.debug("UserIdPool: Reusing existing user_id from pool", {
        providerId,
        poolSize: members.length,
      });
      return currentUserId;
    }

    // 4. 尝试收集：池未满时添加新 user_id
    if (currentUserId && members.length < USER_POOL_CONFIG.POOL_MAX_SIZE) {
      await redis.zadd(poolKey, "NX", now, currentUserId);
      await redis.expire(poolKey, USER_POOL_CONFIG.TTL_SECONDS);
      // 记录绑定关系
      await redis.hset(bindingsKey, sessionId, currentUserId);
      await redis.expire(bindingsKey, USER_POOL_CONFIG.TTL_SECONDS);

      logger.info("UserIdPool: Added new user_id to pool", {
        providerId,
        poolSize: members.length + 1,
      });
      return currentUserId;
    }

    // 5. 兜底映射：池已满或无 currentUserId，用 hash 映射
    if (members.length === 0) {
      logger.debug("UserIdPool: Pool is empty", { providerId });
      return null;
    }

    const hash = simpleHash(sessionId);
    const index = hash % members.length;
    const mappedUserId = members[index];

    // 记录绑定关系
    await redis.hset(bindingsKey, sessionId, mappedUserId);
    await redis.expire(bindingsKey, USER_POOL_CONFIG.TTL_SECONDS);

    logger.debug("UserIdPool: Mapped session to user_id via hash", {
      providerId,
      poolSize: members.length,
      selectedIndex: index,
    });

    return mappedUserId;
  } catch (error) {
    logger.error("UserIdPool: Redis operation failed", {
      error,
      providerId,
    });
    return null;
  }
}

/**
 * 应用供应商 user_id 池映射
 * 封装所有逻辑，供 forwarder.ts 调用
 */
export async function applyUserIdPoolMapping(
  provider: Provider,
  session: ProxySession,
  requestMessage: unknown
): Promise<void> {
  // 检查是否需要启用 user_id 池
  if (!shouldApplyUserIdPool(provider)) {
    return;
  }

  // 检查 sessionId
  const sessionId = session.sessionId;
  if (!sessionId) {
    return;
  }

  // 提取当前 user_id
  const msg = requestMessage as Record<string, unknown>;
  const currentUserId = extractMetadataUserId(msg);

  try {
    const mappedUserId = await getUserIdFromPool(provider.id, sessionId, currentUserId);

    if (mappedUserId) {
      // 修改请求体中的 metadata.user_id
      if (msg.metadata && typeof msg.metadata === "object") {
        (msg.metadata as Record<string, unknown>).user_id = mappedUserId;
      } else {
        msg.metadata = { user_id: mappedUserId };
      }

      logger.debug("UserIdPool: Mapping applied", {
        providerId: provider.id,
        providerName: provider.name,
        sessionId: sessionId.substring(0, 20) + "...",
        hadOriginalUserId: !!currentUserId,
      });
    }
  } catch (error) {
    // Fail-open: 错误不影响请求
    logger.warn("UserIdPool: Mapping failed, continuing", {
      error,
      providerId: provider.id,
    });
  }
}

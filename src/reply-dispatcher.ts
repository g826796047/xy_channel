// Reply dispatcher - completely following feishu/reply-dispatcher.ts pattern
import type { ClawdbotConfig, RuntimeEnv, ReplyPayload } from "openclaw/plugin-sdk";
import { getXYRuntime } from "./runtime.js";
import { sendA2AResponse, sendStatusUpdate, sendReasoningTextUpdate, sendCommand } from "./formatter.js";
import { resolveXYConfig } from "./config.js";
import { getCurrentTaskId, getCurrentMessageId } from "./task-manager.js";
import type { A2ACommand, RunCrossTaskContext, XYChannelConfig } from "./types.js";
import { getCurrentSessionContext } from "./tools/session-manager.js";
import fs from "fs/promises";
import path from "path";

const RUN_CROSS_TASK_LOG_TAG = "[RunCrossTask]";
const STUBBED_CROSS_TASK_RESULT_MESSAGE =
  "https://nsp-vassistant-web-drcn-test.obs.cn-north-4.myhuaweicloud.cn/7d153b74-61fc-420f-8c7a-a316d71d2710.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=HPUAFVHM7YGRRFBX2RNH%2F20260507%2Fcn-north-4%2Fs3%2Faws4_request&X-Amz-Date=20260507T130643Z&X-Amz-Expires=604800&X-Amz-SignedHeaders=host&X-Amz-Signature=f05a93a5c9203aaaf5bc45d076d0f36ba94df4cf597358b488381ab22cf5ea53";

export interface CreateXYReplyDispatcherParams {
  cfg: ClawdbotConfig;
  runtime: RuntimeEnv;
  sessionId: string;
  taskId: string;
  messageId: string;
  accountId: string;
  isSteerFollower?: boolean;  // 🔑 新增：标记是否是steer模式的第二条消息
}

const TEMP_FILE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const TOOL_RESULT_SUMMARY_MAX_CHARS = 300;
const KNOWN_TOOL_NAMES = [
  "create_calendar_event",
  "call_device_tool",
  "call_phone",
  "create_alarm",
  "delete_alarm",
  "discover_cross_devices",
  "get_alarm_tool_schema",
  "get_calendar_tool_schema",
  "get_collection_tool_schema",
  "get_contact_tool_schema",
  "get_device_file_tool_schema",
  "get_email_tool_schema",
  "get_note_tool_schema",
  "get_photo_tool_schema",
  "image_reading",
  "get_user_location",
  "huawei_id_tool",
  "modify_alarm",
  "modify_note",
  "create_note",
  "query_app_message",
  "query_memory_data",
  "query_todo_task",
  "save_file_to_file_manager",
  "save_media_to_gallery",
  "save_self_evolution_skill",
  "search_alarm",
  "search_calendar_event",
  "search_contact",
  "search_email",
  "search_file",
  "search_message",
  "search_notes",
  "search_photo_gallery",
  "send_email",
  "send_file_to_user",
  "send_message",
  "convert_timestamp_to_utc8_time",
  "upload_file",
  "upload_photo",
  "view_push_result",
  "add_collection",
  "query_collection",
  "delete_collection",
  "xiaoyi_gui_agent",
] as const;

const COMPRESSED_TOOL_NAME_MAP = new Map(
  KNOWN_TOOL_NAMES.map((toolName) => [toolName.replace(/_/g, "").toLowerCase(), toolName]),
);

function summarizeToolResult(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= TOOL_RESULT_SUMMARY_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, TOOL_RESULT_SUMMARY_MAX_CHARS - 1)}…`;
}

function formatToolDisplayName(name: string): string {
  const normalized = name.trim();
  const knownName = COMPRESSED_TOOL_NAME_MAP.get(normalized.replace(/[_\-\s]/g, "").toLowerCase()) ?? normalized;
  return knownName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildDistributionStatusCommand(context: RunCrossTaskContext): A2ACommand {
  return {
    header: {
      namespace: "DistributionInteraction",
      name: "DistributionStatus",
    },
    payload: {
      agentId: context.agentId,
      isDistributed: true,
      networkId: context.networkId,
      distributionType: "softbus",
      distributionExecutePolicy: "backgroundExecution",
    },
  };
}

function buildCrossTaskExecuteResultCommand(code: string, message: string, fileUrls: string[] = []): A2ACommand {
  return {
    header: {
      namespace: "DistributionInteraction",
      name: "CrossTaskExecuteResult",
    },
    payload: {
      code,
      message,
      fileUrls,
    },
  };
}

async function sendRunCrossTaskResult(params: {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  context: RunCrossTaskContext;
  resultCode: string;
  resultMessage: string;
}): Promise<void> {
  const { config, sessionId, taskId, messageId, context, resultCode, resultMessage } = params;
  const fileUrls = Array.isArray(context.fileUrls) ? context.fileUrls : [];
  const statusCommand = buildDistributionStatusCommand(context);
  const resultCommand = buildCrossTaskExecuteResultCommand(resultCode, resultMessage, fileUrls);

  console.log(`${RUN_CROSS_TASK_LOG_TAG} sending merged cross-task result commands`, {
    statusCommand,
    resultCommand,
    cachedFileUrls: fileUrls,
  });
  await sendCommand({
    config,
    sessionId,
    taskId,
    messageId,
    commands: [statusCommand, resultCommand],
  });

  console.log(`${RUN_CROSS_TASK_LOG_TAG} merged cross task result commands sent`, {
    sessionId,
    taskId,
    resultCode,
    resultMessageLength: resultMessage.length,
    fileUrlCount: fileUrls.length,
  });
}

/**
 * 清理 /tmp/xy_channel 目录中超过 24 小时的旧文件
 */
export async function cleanupStaleTempFiles(tempDir: string = "/tmp/xy_channel"): Promise<void> {
  try {
    const stats = await fs.stat(tempDir).catch(() => null);
    if (!stats?.isDirectory()) {
      return;
    }

    const files = await fs.readdir(tempDir);
    const now = Date.now();
    let cleanedCount = 0;

    for (const file of files) {
      const filePath = path.join(tempDir, file);
      try {
        const fileStat = await fs.stat(filePath);
        if (now - fileStat.mtimeMs > TEMP_FILE_TTL_MS) {
          await fs.unlink(filePath);
          cleanedCount++;
        }
      } catch (err) {
        // 忽略单个文件处理失败
      }
    }

    if (cleanedCount > 0) {
      console.log(`[CLEANUP] 🧹 Cleaned ${cleanedCount} stale files (>${TEMP_FILE_TTL_MS / 1000 / 3600}h) from ${tempDir}`);
    }
  } catch (err) {
    console.error(`[CLEANUP] ❌ Failed to cleanup temp dir:`, err);
  }
}

/**
 * Create a reply dispatcher for XY channel messages.
 * Follows feishu pattern with status updates and streaming support.
 * Runtime is expected to be validated before calling this function.
 */
export function createXYReplyDispatcher(params: CreateXYReplyDispatcherParams): any {
  const { cfg, runtime, sessionId, taskId, messageId, accountId, isSteerFollower } = params;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  log(`[DISPATCHER-CREATE] ******* Creating dispatcher *******`);
  log(`[DISPATCHER-CREATE]   - taskId: ${taskId}`);
  log(`[DISPATCHER-CREATE]   - isSteerFollower: ${isSteerFollower ?? false}`);

  // 初始taskId和messageId（作为fallback）
  const initialTaskId = taskId;
  const initialMessageId = messageId;

  /**
   * 🔑 核心改造：动态获取当前活跃的taskId和messageId
   * 每次需要taskId时，都从TaskManager获取最新值
   */
  const getActiveTaskId = (): string => {
    return getCurrentTaskId(sessionId) ?? initialTaskId;
  };

  const getActiveMessageId = (): string => {
    return getCurrentMessageId(sessionId) ?? initialMessageId;
  };

  const core = getXYRuntime();
  const config: XYChannelConfig = resolveXYConfig(cfg);
  // Simplified prefix context for single-account Xiaoyi channel
  const prefixContext = {
    responsePrefix: undefined,
    responsePrefixContextProvider: undefined,
    onModelSelected: undefined,
  };

  let statusUpdateInterval: NodeJS.Timeout | null = null;
  let hasSentResponse = false;
  let finalSent = false;
  let accumulatedText = "";
  let hasSentReasoningTrace = false;
  const initialRunCrossTaskContext = getCurrentSessionContext()?.runCrossTaskContext;
  if (initialRunCrossTaskContext) {
    console.log(`${RUN_CROSS_TASK_LOG_TAG} dispatcher created for distributed task`, {
      sessionId,
      taskId,
      agentId: initialRunCrossTaskContext.agentId,
      networkId: initialRunCrossTaskContext.networkId,
    });
  }

  const getRunCrossTaskContext = (): RunCrossTaskContext | undefined => {
    return getCurrentSessionContext()?.runCrossTaskContext ?? initialRunCrossTaskContext;
  };

  const formatReasoningTraceLine = (text: string): string => {
    const prefix = hasSentReasoningTrace ? "\n" : "";
    hasSentReasoningTrace = true;
    return `${prefix}${text}`;
  };

  /**
   * Start the status update interval
   */
  const startStatusInterval = () => {
    log(`[STATUS INTERVAL] Starting interval for session ${sessionId}`);

    statusUpdateInterval = setInterval(() => {
      // 🔑 使用动态taskId
      const currentTaskId = getActiveTaskId();
      const currentMessageId = getActiveMessageId();

      log(`[STATUS INTERVAL] Triggering status update`);
      log(`[STATUS INTERVAL]   - sessionId: ${sessionId}`);
      log(`[STATUS INTERVAL]   - currentTaskId: ${currentTaskId}`);

      void sendStatusUpdate({
        config,
        sessionId,
        taskId: currentTaskId,  // 🔑 动态taskId
        messageId: currentMessageId,  // 🔑 动态messageId
        text: "任务正在处理中，请稍候~",
        state: "working",
      }).catch((err) => {
        error(`Failed to send status update:`, err);
      });
    }, 30000); // 30 seconds
  };

  const stopStatusInterval = () => {
    if (statusUpdateInterval) {
      log(`[STATUS INTERVAL] Stopping interval for session ${sessionId}`);
      clearInterval(statusUpdateInterval);
      statusUpdateInterval = null;
    }
  };

  const { dispatcher, replyOptions, markDispatchIdle } =
    core.channel.reply.createReplyDispatcherWithTyping({
      responsePrefix: prefixContext.responsePrefix,
      responsePrefixContextProvider: prefixContext.responsePrefixContextProvider,
      humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, accountId),

      onReplyStart: () => {
        const currentTaskId = getActiveTaskId();
        log(`[REPLY START] Reply started for session ${sessionId}, taskId=${currentTaskId}, isSteerFollower=${isSteerFollower}`);
      },

      deliver: async (payload: ReplyPayload, info) => {
        const text = payload.text ?? "";
        const currentTaskId = getActiveTaskId();

        log(`[DELIVER] sessionId=${sessionId}, taskId=${currentTaskId}, info.kind=${info?.kind}, text.length=${text.length}`);

        try {
          if (!text.trim()) {
            log(`[DELIVER SKIP] Empty text, skipping`);
            return;
          }

          accumulatedText += text;
          hasSentResponse = true;
          log(`[DELIVER ACCUMULATE] Accumulated text, current length=${accumulatedText.length}`);
          log(`[DELIVER] ✅ Accumulated assistant text for final response only`);
        } catch (deliverError) {
          error(`Failed to deliver message:`, deliverError);
        }
      },

      onError: async (err, info) => {
        runtime.error?.(`xy: ${info.kind} reply failed: ${String(err)}`);
        stopStatusInterval();

        // 🔑 steer follower不发送错误状态（让主dispatcher处理）
        if (isSteerFollower) {
          log(`[ON_ERROR] Steer follower - skipping error response`);
          return;
        }

        if (!hasSentResponse) {
          const currentTaskId = getActiveTaskId();
          const currentMessageId = getActiveMessageId();

          try {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "处理失败，请稍后重试",
              state: "failed",
            });
          } catch (statusError) {
            error(`Failed to send error status:`, statusError);
          }
        }
      },

      onIdle: async () => {
        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        log(`[ON_IDLE] Reply idle`);
        log(`[ON_IDLE]   - sessionId: ${sessionId}`);
        log(`[ON_IDLE]   - taskId: ${currentTaskId}`);
        log(`[ON_IDLE]   - isSteerFollower: ${isSteerFollower}`);
        log(`[ON_IDLE]   - hasSentResponse: ${hasSentResponse}`);
        log(`[ON_IDLE]   - finalSent: ${finalSent}`);

        // 🔑 核心改动：steer follower不发送final响应
        if (isSteerFollower) {
          log(`[ON_IDLE] Steer follower - skipping final response`);
          log(`[ON_IDLE]   - Message queued successfully, waiting for primary dispatcher`);
          stopStatusInterval();
          return;  // ← 直接返回，不发送任何东西！
        }

        // 正常模式（或steer的第一条消息）
        if (hasSentResponse && !finalSent) {
          log(`[ON_IDLE] Sending accumulated text, length=${accumulatedText.length}`);
          try {
            // 🔑 使用动态taskId发送完成状态
            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "任务处理已完成~",
              state: "completed",
            });
            log(`[ON_IDLE] ✅ Sent completion status update`);

            const runCrossTaskContext = getRunCrossTaskContext();
            if (runCrossTaskContext) {
              console.log(`${RUN_CROSS_TASK_LOG_TAG} model task completed, preparing cross-device result before final response`, {
                sessionId,
                taskId: currentTaskId,
                messageLength: accumulatedText.length,
              });
              await sendRunCrossTaskResult({
                config,
                sessionId,
                taskId: currentTaskId,
                messageId: currentMessageId,
                context: runCrossTaskContext,
                resultCode: "0",
                resultMessage: accumulatedText, //    打桩： STUBBED_CROSS_TASK_RESULT_MESSAGE
              });
            }

            // 🔑 使用动态taskId发送最终响应
            await sendA2AResponse({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: accumulatedText,
              append: false,
              final: true,
            });
            finalSent = true;
            log(`[ON_IDLE] ✅ Sent final response with taskId=${currentTaskId}`);
          } catch (err) {
            error(`[ON_IDLE] Failed to send final response:`, err);
          }
        } else {
          // 正常失败场景（非steer follower）
          log(`[ON_IDLE] Skipping final message: hasSentResponse=${hasSentResponse}, finalSent=${finalSent}`);
          try {
            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "任务处理中断了~",
              state: "failed",
            });
            log(`[ON_IDLE] ✅ Sent failure status update`);

            const runCrossTaskContext = getRunCrossTaskContext();
            if (runCrossTaskContext) {
              console.log(`${RUN_CROSS_TASK_LOG_TAG} model task failed, preparing cross-device failure result before final response`, {
                sessionId,
                taskId: currentTaskId,
              });
              await sendRunCrossTaskResult({
                config,
                sessionId,
                taskId: currentTaskId,
                messageId: currentMessageId,
                context: runCrossTaskContext,
                resultCode: "1",
                resultMessage: "任务执行异常，请重试",
              });
            }

            await sendA2AResponse({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: "任务执行异常，请重试~",
              append: false,
              final: true,
              errorCode: 99921111,
              errorMessage: "任务执行异常，请重试",
            });
            finalSent = true;
            log(`[ON_IDLE] ✅ Sent error response with code: 99921111`);
          } catch (err) {
            error(`[ON_IDLE] Failed to send error response:`, err);
          }
        }

        stopStatusInterval();
      },

      onCleanup: () => {
        const currentTaskId = getActiveTaskId();
        log(`[ON_CLEANUP] Reply cleanup, taskId=${currentTaskId}, isSteerFollower=${isSteerFollower}`);
      },
    });

  return {
    dispatcher,
    replyOptions: {
      ...replyOptions,
      onModelSelected: prefixContext.onModelSelected,

      onToolStart: async ({ name, phase }) => {
        // 🔑 steer follower不发送tool状态（让主dispatcher处理）
        if (isSteerFollower) {
          return;
        }

        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();

        log(`[TOOL START] Tool: ${name}, phase: ${phase}, taskId: ${currentTaskId}`);

        if (phase === "start") {
          const toolName = name || "unknown";
          const toolDisplayName = formatToolDisplayName(toolName);

          // call_device_tool 由自身 execute() 内部发送具体子工具名的状态更新
          // get_xxx_tool_schema 是给 LLM 查 schema 用的，无需向用户展示
          if (toolName === "call_device_tool" || toolName.endsWith("_tool_schema")) {
            log(`[TOOL START] Skipping generic status for ${toolName}`);
            return;
          }

          try {
            await sendReasoningTextUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: formatReasoningTraceLine(`🔧 调用工具：${toolDisplayName}`),
            });
            log(`[TOOL START] ✅ Sent ReACT trace for tool start: ${toolDisplayName}`);

            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: `正在使用工具: ${toolDisplayName}...`,
              state: "working",
            });
            log(`[TOOL START] ✅ Sent status update for tool start: ${toolDisplayName}`);
          } catch (err) {
            error(`[TOOL START] ❌ Failed to send tool start status:`, err);
          }
        }
      },

      onToolResult: async (payload: ReplyPayload) => {
        // 🔑 steer follower不发送tool结果（让主dispatcher处理）
        if (isSteerFollower) {
          return;
        }

        const currentTaskId = getActiveTaskId();
        const currentMessageId = getActiveMessageId();
        const text = payload.text ?? "";
        const hasMedia = Boolean(payload.mediaUrl || (payload.mediaUrls?.length ?? 0) > 0);

        log(`[TOOL RESULT] Tool result, taskId: ${currentTaskId}, text.length: ${text.length}`);

        try {
          if (text.length > 0 || hasMedia) {
            const resultText = text.length > 0 ? text : "工具执行完成";
            const reactTraceText =
              text.length > 0
                ? `✅ 工具完成：${summarizeToolResult(text)}`
                : "✅ 工具完成：已生成/返回媒体结果";

            await sendReasoningTextUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: formatReasoningTraceLine(reactTraceText),
            });
            log(`[TOOL RESULT] ✅ Sent ReACT trace for tool result`);

            await sendStatusUpdate({
              config,
              sessionId,
              taskId: currentTaskId,
              messageId: currentMessageId,
              text: resultText,
              state: "working",
            });
            log(`[TOOL RESULT] ✅ Sent tool result as status update`);
          }
        } catch (err) {
          error(`[TOOL RESULT] ❌ Failed to send tool result status:`, err);
        }
      },

      onReasoningStream: async (payload: ReplyPayload) => {
        // 🔑 steer follower不发送reasoning stream
        if (isSteerFollower) {
          return;
        }

        const text = payload.text ?? "";
        log(`[REASONING STREAM] Reasoning chunk received, text.length: ${text.length}`);

        // Reasoning stream 目前被注释掉
        // 如果需要可以启用
      },

      onPartialReply: async (payload: ReplyPayload) => {
        // 🔑 steer follower不发送partial reply（让主dispatcher处理）
        if (isSteerFollower) {
          return;
        }

        const text = payload.text ?? "";
        log(`[PARTIAL REPLY] Partial assistant text received but not sent as reasoningText, text.length=${text.length}`);
      },
    },
    markDispatchIdle,
    startStatusInterval,
    stopStatusInterval,
  };
}

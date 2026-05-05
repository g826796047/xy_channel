// OpenClaw → A2A format conversion
import { v4 as uuidv4 } from "uuid";
import { getXYWebSocketManager } from "./client.js";
import { getXYRuntime } from "./runtime.js";
import type { RuntimeEnv } from "openclaw/plugin-sdk";
import type {
  XYChannelConfig,
  A2AJsonRpcResponse,
  A2ATaskArtifactUpdateEvent,
  A2ATaskStatusUpdateEvent,
  OutboundWebSocketMessage,
  A2ACommand,
} from "./types.js";

const GET_PC_DEVICE_LIST_LOG_TAG = "[GetPCDeviceList]";
const SEND_PC_DEVICE_TASK_LOG_TAG = "[SendPcDeviceTask]";

/**
 * Parameters for sending an A2A response.
 */
export interface SendA2AResponseParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  text?: string;
  append: boolean;
  final: boolean;
  files?: Array<{ fileName: string; fileType: string; fileId: string }>;
  errorCode?: number | string; // 错误码，用于任务执行异常场景
  errorMessage?: string; // 错误描述
}

/**
 * Send an A2A artifact update response.
 */
export async function sendA2AResponse(params: SendA2AResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, append, final, files, errorCode, errorMessage } = params;

  const runtime = getXYRuntime() as any;
  const log = runtime?.log ?? console.log;
  const errorFn = runtime?.error ?? console.error;

  // Build artifact update event
  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    kind: "artifact-update",
    append,
    lastChunk: true,
    final,
    artifact: {
      artifactId: uuidv4(),
      parts: [],
    },
  };

  // Add text part (even if empty string, to maintain parts structure)
  if (text !== undefined) {
    artifact.artifact.parts.push({
      kind: "text",
      text,
    });
  }

  // Add file parts if provided
  if (files && files.length > 0) {
    artifact.artifact.parts.push({
      kind: "data",
      data: { fileInfo: files },
    });
  }

  // Build JSON-RPC response
  const jsonRpcResponse: any = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  // 🔑 添加 error 字段（仅当提供 errorCode 时）
  if (errorCode !== undefined) {
    jsonRpcResponse.error = {
      code: errorCode,
      message: errorMessage ?? "任务执行异常，请重试",
    };
    log(`[A2A_RESPONSE] ⚠️ Including error code: ${errorCode}`);
  }

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  // 📋 Log complete response body
  log(`[A2A_RESPONSE] 📤 Sending A2A artifact-update response: taskId: ${taskId}`);
  log(`[A2A_RESPONSE]   - append: ${append}`);
  log(`[A2A_RESPONSE]   - final: ${final}`);
  log(`[A2A_RESPONSE]   - text: ${text.length <= 10 ? text : text.slice(0, 5) + '***' + text.slice(-5)}`);
  log(`[A2A_RESPONSE]   - files count: ${files?.length ?? 0}`);

  await wsManager.sendMessage(sessionId, outboundMessage);
  log(`[A2A_RESPONSE] ✅ Message sent successfully`);
}

/**
 * Parameters for sending a reasoning text update (intermediate, streamed).
 */
export interface SendReasoningTextUpdateParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  text: string;
  append?: boolean; // defaults to true
}

/**
 * Send an A2A artifact-update with reasoningText part.
 * Used for onToolStart, onToolResult, onReasoningStream, onReasoningEnd, onPartialReply.
 * append=true, final=false, lastChunk=true, text is suffixed with newline for markdown rendering.
 */
export async function sendReasoningTextUpdate(params: SendReasoningTextUpdateParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, append = true } = params;

  const runtime = getXYRuntime() as any;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    kind: "artifact-update",
    append,
    lastChunk: true,
    final: false,
    artifact: {
      artifactId: uuidv4(),
      parts: [
        {
          kind: "reasoningText",
          reasoningText: text,
        },
      ],
    },
  };

  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };
  await wsManager.sendMessage(sessionId, outboundMessage);
}

/**
 * Parameters for sending a status update.
 */
export interface SendStatusUpdateParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  text: string;
  state: "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "unknown";
}

/**
 * Send an A2A task status update.
 * Follows A2A protocol standard format with nested status object.
 */
export async function sendStatusUpdate(params: SendStatusUpdateParams): Promise<void> {
  const { config, sessionId, taskId, messageId, text, state } = params;

  const runtime = getXYRuntime() as any;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Build status update event following A2A protocol standard
  const statusUpdate: A2ATaskStatusUpdateEvent = {
    taskId,
    kind: "status-update",
    final: false, // Status updates should not end the stream
    status: {
      message: {
        role: "agent",
        parts: [
          {
            kind: "text",
            text,
          },
        ],
      },
      state,
    },
  };

  // Build JSON-RPC response
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: statusUpdate,
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  // 📋 Log complete response body
  log(`[A2A_STATUS] 📤 Sending A2A status-update:`);
  log(`[A2A_STATUS]   - taskId: ${taskId}`);
  log(`[A2A_STATUS]   - text: "${text}"`);

  await wsManager.sendMessage(sessionId, outboundMessage);
}

/**
 * Parameters for sending a command.
 */
export interface SendCommandParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  command: A2ACommand;
}

/**
 * Send a command as an artifact update (final=false).
 */
export async function sendCommand(params: SendCommandParams): Promise<void> {
  const { config, sessionId, taskId, messageId, command } = params;

  const runtime = getXYRuntime() as any;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Build artifact update with command as data
  // Wrap command in commands array as per protocol requirement
  const artifact: A2ATaskArtifactUpdateEvent = {
    taskId,
    kind: "artifact-update",
    append: false,
    lastChunk: true,
    final: false, // Commands are not final
    artifact: {
      artifactId: uuidv4(),
      parts: [
        {
          kind: "data",
          data: {
            commands: [command],
          },
        },
      ],
    },
  };

  // Build JSON-RPC response
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: artifact,
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  if (command?.payload?.executeParam?.intentName === "SearchAllDeviceInfo") {
    console.log(`${GET_PC_DEVICE_LIST_LOG_TAG} sending command outbound message`, outboundMessage);
  }
  if (command?.header?.namespace === "DistributionInteraction" && command?.header?.name === "UnifiedDistribute") {
    console.log(`${SEND_PC_DEVICE_TASK_LOG_TAG} sending command outbound message`, outboundMessage);
  }

  // 📋 Log complete response body
  log(`[A2A_COMMAND] 📤 Sending A2A command: taskId: ${taskId}`);
  await wsManager.sendMessage(sessionId, outboundMessage);
  log(`[A2A_COMMAND] ✅ Command sent successfully`);
}

/**
 * Parameters for sending a clearContext response.
 */
export interface SendClearContextResponseParams {
  config: XYChannelConfig;
  sessionId: string;
  messageId: string;
}

/**
 * Send a clearContext response.
 */
export async function sendClearContextResponse(params: SendClearContextResponseParams): Promise<void> {
  const { config, sessionId, messageId } = params;

  const runtime = getXYRuntime() as any;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Build JSON-RPC response for clearContext
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: {
      status: {
        state: "cleared",
      },
    },
    error: {
      code: 0,
  // Note: Using any to bypass type check as the response format differs from standard A2A types
      message: "",
    },
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId: sessionId, // Use sessionId as taskId for clearContext
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  await wsManager.sendMessage(sessionId, outboundMessage);
  log(`Sent clearContext response: sessionId=${sessionId}`);
}

/**
 * Parameters for sending a tasks/cancel response.
 */
export interface SendTasksCancelResponseParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
}

/**
 * Send a tasks/cancel response.
 */
export async function sendTasksCancelResponse(params: SendTasksCancelResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId } = params;

  const runtime = getXYRuntime() as any;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Build JSON-RPC response for tasks/cancel
  // Note: Using any to bypass type check as the response format differs from standard A2A types
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: {
      id: taskId,
      status: {
        state: "canceled",
      },
    },
    error: {
      code: 0,
      message: "",
    },
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  await wsManager.sendMessage(sessionId, outboundMessage);
  log(`Sent tasks/cancel response: sessionId=${sessionId}, taskId=${taskId}`);
}

/**
 * Parameters for sending a Trigger response.
 */
export interface SendTriggerResponseParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  content: string;
}

/**
 * Send a Trigger response with pushData content.
 */
export async function sendTriggerResponse(params: SendTriggerResponseParams): Promise<void> {
  const { config, sessionId, taskId, messageId, content } = params;

  const runtime = getXYRuntime() as any;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  // Build JSON-RPC response for Trigger
  const jsonRpcResponse = {
    jsonrpc: "2.0",
    id: messageId,
    result: {
      taskId: taskId,
      kind: "artifact-update",
      append: false,
      lastChunk: true,
      final: true,
      artifact: {
        artifactId: uuidv4(),
        parts: [
          {
            kind: "text",
            text: content,
          },
        ],
      },
    },
    error: {
      code: 0,
      message: "",
    },
  };

  // Send via WebSocket
  const wsManager = getXYWebSocketManager(config);
  const outboundMessage: OutboundWebSocketMessage = {
    msgType: "agent_response",
    agentId: config.agentId,
    sessionId,
    taskId,
    msgDetail: JSON.stringify(jsonRpcResponse),
  };

  log(`[TRIGGER_RESPONSE] Sending Trigger response: sessionId=${sessionId}, taskId=${taskId}`);
  await wsManager.sendMessage(sessionId, outboundMessage);
  log(`[TRIGGER_RESPONSE] Trigger response sent successfully`);
}

// ============================================================================
// DirectivesForward — 跨设备执行结果下发
// ============================================================================

const DIRECTIVES_FORWARD_LOG_TAG = "[DirectivesForward]";

/**
 * Parameters for building a directivesForward command.
 */
export interface BuildDirectivesForwardParams {
  agentId: string;
  networkId: string;
  resultCode: string;
  resultMessage: string;
}

/**
 * Build a directivesForward A2A command.
 * DistributionStatus is always the first directive to tell the device side
 * that this is a cross-device distribution scenario.
 */
export function buildDirectivesForwardCommand(params: BuildDirectivesForwardParams): A2ACommand {
  const { agentId, networkId, resultCode, resultMessage } = params;

  console.log(`[IF610] buildDirectivesForwardCommand: agentId=${agentId}, networkId=${networkId}, code=${resultCode}`);
  console.log(`[IF610] buildDirectivesForwardCommand: message=${resultMessage.length > 200 ? resultMessage.slice(0, 200) + "..." : resultMessage}`);

  return {
    header: {
      namespace: "DistributionInteraction",
      name: "DirectivesForward",
    },
    payload: {
      executeType: "directivesForward",
      directives: [
        {
          header: {
            name: "DistributionStatus",
            namespace: "DistributionInteraction",
          },
          payload: {
            agentId,
            isDistributed: true,
            networkId,
            distributionType: "softbus",
            distributionExecutePolicy: "backgroundExecution",
          },
        },
        {
          header: {
            namespace: "DistributionInteraction",
            name: "CrossTaskExecuteResult",
          },
          payload: {
            code: resultCode,
            message: resultMessage,
          },
        },
      ],
    },
  };
}

/**
 * Parameters for sending a directivesForward command.
 */
export interface SendDirectivesForwardParams {
  config: XYChannelConfig;
  sessionId: string;
  taskId: string;
  messageId: string;
  agentId: string;
  networkId: string;
  resultCode: string;
  resultMessage: string;
}

/**
 * Build and send a directivesForward command to the PC device side.
 */
export async function sendDirectivesForward(params: SendDirectivesForwardParams): Promise<void> {
  const { config, sessionId, taskId, messageId, agentId, networkId, resultCode, resultMessage } = params;

  const runtime = getXYRuntime() as any;
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  const command = buildDirectivesForwardCommand({
    agentId,
    networkId,
    resultCode,
    resultMessage,
  });

  log(`${DIRECTIVES_FORWARD_LOG_TAG} built directivesForward command, networkId=${networkId}, code=${resultCode}`);

  await sendCommand({
    config,
    sessionId,
    taskId,
    messageId,
    command,
  });

  log(`${DIRECTIVES_FORWARD_LOG_TAG} sent successfully`);
  console.log(`[IF610] sendDirectivesForward: sent to sessionId=${sessionId}, taskId=${taskId}`);
}

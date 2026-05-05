import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { sendA2AResponse, sendCommand, sendDirectivesForward } from "../formatter.js";
import { getXYWebSocketManager } from "../client.js";
import { getCurrentMessageId, getCurrentTaskId } from "../task-manager.js";
import type { A2ACommand, CrossDeviceTaskResultEvent } from "../types.js";
import { getCurrentSessionContext } from "./session-manager.js";

const LOG_TAG = "[SendPcDeviceTask]";
const CROSS_DEVICE_TASK_TIMEOUT_MS = 120_000;

type TargetDeviceInfo = {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  networkId?: string;
};

function stringifyForLog(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return `[Unserializable value: ${error instanceof Error ? error.message : String(error)}]`;
  }
}

function buildResultText(result: Record<string, unknown>): {
  content: Array<{ type: "text"; text: string }>;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(result),
      },
    ],
  };
}

function normalizeTargetDeviceInfo(value: unknown): TargetDeviceInfo | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const deviceId = typeof candidate.deviceId === "string" ? candidate.deviceId.trim() : "";
  const deviceName = typeof candidate.deviceName === "string" ? candidate.deviceName.trim() : "";
  const deviceType = typeof candidate.deviceType === "string" ? candidate.deviceType.trim() : "";

  if (!deviceId || !deviceName || !deviceType) {
    return null;
  }

  const networkId = typeof candidate.networkId === "string" ? candidate.networkId.trim() : undefined;

  return {
    deviceId,
    deviceName,
    deviceType,
    networkId: networkId || undefined,
  };
}

function buildUnifiedDistributeCommand(query: string, targetDeviceInfo: TargetDeviceInfo): A2ACommand {
  return {
    header: {
      namespace: "DistributionInteraction",
      name: "UnifiedDistribute",
    },
    payload: {
      targetDeviceInfo,
      crossDeviceContent: {
        query,
        contexts: {
          agentClientContext: {
            header: {
              namespace: "System",
              name: "ClientContext",
            },
            payload: {
              agentId: "",
              isSupportAgent: true,
            },
          },
        },
      },
    },
  };
}

export const sendCrossDeviceTaskTool: any = {
  name: "send_cross_device_task",
  label: "下发跨设备协作任务",
  description: `向用户已经选定的目标设备下发跨设备协作任务。

使用流程：
1. 必须先调用 discover_cross_devices 获取设备列表。
2. 根据用户原始需求选择唯一目标设备。
3. 如果存在多个同类型候选设备，或无法判断目标设备，必须先询问用户选择设备，不要调用本工具。
4. 只有当 targetDeviceInfo 中的 deviceId、deviceName、deviceType 都已明确时，才调用本工具。

本工具会让端侧通过软总线把任务分发到目标设备执行，并等待端侧返回执行结果。当前阶段只透传端侧返回的 fileurl/message，不封装卡片指令。`,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "用户原始跨设备任务需求，例如：从 PC 获取某文件。",
      },
      targetDeviceInfo: {
        type: "object",
        description: "模型从 discover_cross_devices 返回列表中选定的唯一目标设备。",
        properties: {
          deviceId: {
            type: "string",
            description: "目标设备 ID。",
          },
          deviceName: {
            type: "string",
            description: "目标设备名称。",
          },
          deviceType: {
            type: "string",
            description: "目标设备类型编号，例如 00B、00C、011、00E。",
          },
          networkId: {
            type: "string",
            description: "目标设备的软总线网络 ID，用于跨设备指令转发路由。",
          },
        },
        required: ["deviceId", "deviceName", "deviceType"],
      },
    },
    required: ["query", "targetDeviceInfo"],
  },

  async execute(_toolCallId: string, params: any) {
    console.log(`${LOG_TAG} tool invoked, params=${stringifyForLog(params)}`);

    const query = typeof params.query === "string" ? params.query.trim() : "";
    const targetDeviceInfo = normalizeTargetDeviceInfo(params.targetDeviceInfo);
    console.log(`[IF610] send_cross_device_task invoked, query=${query}`);

    if (!query || !targetDeviceInfo) {
      console.log(`${LOG_TAG} invalid params, query=${query}, targetDeviceInfo=${stringifyForLog(params.targetDeviceInfo)}`);
      return buildResultText({
        success: false,
        code: "",
        message: "Missing required parameters: query and targetDeviceInfo.deviceId/deviceName/deviceType.",
        fileUrl: "",
        rawEvent: null,
        cardInstructionStatus: "reserved_not_implemented",
      });
    }

    const sessionContext = getCurrentSessionContext();
    if (!sessionContext) {
      console.log(`${LOG_TAG} no active XY session found`);
      return buildResultText({
        success: false,
        code: "",
        message: "No active XY session found. Cross-device task can only run during an active conversation.",
        fileUrl: "",
        rawEvent: null,
        cardInstructionStatus: "reserved_not_implemented",
      });
    }

    const { config, sessionId } = sessionContext;
    const taskId = getCurrentTaskId(sessionId) ?? sessionContext.taskId;
    const messageId = getCurrentMessageId(sessionId) ?? sessionContext.messageId;
    const wsManager = getXYWebSocketManager(config);
    const command = buildUnifiedDistributeCommand(query, targetDeviceInfo);
    const statusText = `正在调用${targetDeviceInfo.deviceName}执行${query}...`;

    console.log(
      `${LOG_TAG} session context resolved, sessionId=${sessionId}, taskId=${taskId}, messageId=${messageId}`,
    );
    console.log(`${LOG_TAG} selected targetDeviceInfo=${stringifyForLog(targetDeviceInfo)}`);
    console.log(`${LOG_TAG} prepared UnifiedDistribute command=${stringifyForLog(command)}`);
    console.log(`[IF610] targetDeviceInfo: deviceId=${targetDeviceInfo.deviceId}, networkId=${targetDeviceInfo.networkId ?? "N/A"}, session networkId=${sessionContext.networkId ?? "N/A"}`);

    return new Promise((resolve) => {
      let timeout: NodeJS.Timeout;
      let handler: (event: CrossDeviceTaskResultEvent) => void;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        wsManager.off("cross-device-task-result", handler);
        console.log(`${LOG_TAG} cleaned up cross-device-task-result listener`);
      };

      const finish = (result: Record<string, unknown>) => {
        if (settled) {
          return;
        }
        settled = true;
        console.log(`${LOG_TAG} finishing tool result=${stringifyForLog(result)}`);
        cleanup();
        resolve(buildResultText(result));
      };

      handler = (event: CrossDeviceTaskResultEvent) => {
        console.log(`${LOG_TAG} received cross-device-task-result=${stringifyForLog(event)}`);
        if (event.sessionId && event.sessionId !== sessionId) {
          console.log(`${LOG_TAG} ignoring result for sessionId=${event.sessionId}`);
          return;
        }

        // 🔑 收到远端结果后，自动构建 directivesForward 下发给 PC 端侧
        const directivesNetworkId = targetDeviceInfo.networkId ?? sessionContext.networkId ?? "";
        console.log(
          `${LOG_TAG} sending directivesForward to PC, networkId=${directivesNetworkId}, code=${event.code}`,
        );
        console.log(
          `[IF610] directivesForward triggered: sessionId=${sessionId}, taskId=${taskId}, networkId=${directivesNetworkId}, code=${event.code}, status=${event.status}`,
        );
        sendDirectivesForward({
          config,
          sessionId,
          taskId,
          messageId,
          agentId: config.agentId,
          networkId: directivesNetworkId,
          resultCode: event.code,
          resultMessage: event.message,
        })
          .then(() => {
            console.log(`${LOG_TAG} directivesForward sent successfully`);
            console.log(`[IF610] directivesForward sent OK`);
          })
          .catch((dfError) => {
            console.error(
              `${LOG_TAG} failed to send directivesForward: ${dfError instanceof Error ? dfError.message : String(dfError)}`,
            );
            console.error(`[IF610] directivesForward send FAILED: ${dfError instanceof Error ? dfError.message : String(dfError)}`);
          });

        finish({
          success: event.status === "success",
          code: event.code,
          message: event.message,
          fileUrl: event.message,
          rawEvent: event.rawEvent,
          cardInstructionStatus: "reserved_not_implemented",
        });
      };

      timeout = setTimeout(() => {
        console.log(`${LOG_TAG} timeout waiting System.ClientContext after ${CROSS_DEVICE_TASK_TIMEOUT_MS}ms`);
        finish({
          success: false,
          code: "",
          message: `Cross-device task timed out after ${CROSS_DEVICE_TASK_TIMEOUT_MS / 1000} seconds.`,
          fileUrl: "",
          rawEvent: null,
          cardInstructionStatus: "reserved_not_implemented",
        });
      }, CROSS_DEVICE_TASK_TIMEOUT_MS);

      wsManager.on("cross-device-task-result", handler);
      console.log(`${LOG_TAG} cross-device-task-result listener registered, timeoutMs=${CROSS_DEVICE_TASK_TIMEOUT_MS}`);

      console.log(`${LOG_TAG} sending text update=${statusText}`);
      sendA2AResponse({
        config,
        sessionId,
        taskId,
        messageId,
        text: statusText,
        append: false,
        final: false,
      })
        .then(() => {
          console.log(`${LOG_TAG} text update sent, sending command=${stringifyForLog(command)}`);
          return sendCommand({
            config,
            sessionId,
            taskId,
            messageId,
            command,
          });
        })
        .then(() => {
          console.log(`${LOG_TAG} UnifiedDistribute command sent successfully`);
        })
        .catch((error) => {
          console.error(
            `${LOG_TAG} failed to send cross-device task command: ${error instanceof Error ? error.message : String(error)}`,
          );
          finish({
            success: false,
            code: "",
            message: `Failed to send cross-device task command: ${error instanceof Error ? error.message : String(error)}`,
            fileUrl: "",
            rawEvent: null,
            cardInstructionStatus: "reserved_not_implemented",
          });
        });
    });
  },
};

import type { ChannelAgentTool } from "openclaw/plugin-sdk";
import { sendCommand, sendStatusUpdate } from "../formatter.js";
import { getXYWebSocketManager } from "../client.js";
import { getCurrentMessageId, getCurrentTaskId } from "../task-manager.js";
import type { A2ACommand, A2ADataEvent } from "../types.js";
import { getCurrentSessionContext } from "./session-manager.js";

const DISCOVER_DEVICES_INTENT = "SearchAllDeviceInfo";
const DISCOVER_DEVICES_BUNDLE = "com.huawei.hmos.vassistant";
const DISCOVER_DEVICES_TIMEOUT_MS = 30_000;
const DISCOVER_DEVICES_STATUS_TEXT = "正在查询设备列表...";

const DEVICE_TYPE_LABELS: Record<string, string> = {
  "00E": "phone",
  "011": "tablet",
  "00B": "desktop",
  "00C": "laptop",
};

type RawDeviceInfo = {
  deviceId?: unknown;
  deviceName?: unknown;
  deviceType?: unknown;
  nearby?: unknown;
  [key: string]: unknown;
};

type NormalizedDeviceInfo = {
  deviceId: string;
  deviceName: string;
  deviceType: string;
  deviceTypeLabel: string;
  nearby: boolean;
  rawDevice: RawDeviceInfo;
};

function normalizeDevices(rawDevices: unknown): NormalizedDeviceInfo[] {
  if (!Array.isArray(rawDevices)) {
    return [];
  }

  return rawDevices
    .filter((item): item is RawDeviceInfo => Boolean(item) && typeof item === "object")
    .map((device) => {
      const deviceType = typeof device.deviceType === "string" ? device.deviceType : "";
      return {
        deviceId: typeof device.deviceId === "string" ? device.deviceId : "",
        deviceName: typeof device.deviceName === "string" ? device.deviceName : "",
        deviceType,
        deviceTypeLabel: DEVICE_TYPE_LABELS[deviceType] ?? "unknown",
        nearby: device.nearby === true,
        rawDevice: device,
      };
    });
}

function inferDesiredDeviceTypes(query: string): string[] {
  const normalized = query.toLowerCase();

  if (/(pc|computer|desktop|laptop|notebook)/iu.test(normalized) || /电脑|台式机|笔记本/iu.test(query)) {
    return ["00B", "00C"];
  }

  if (/(tablet|pad|ipad)/iu.test(normalized) || /平板/iu.test(query)) {
    return ["011"];
  }

  if (/(phone|mobile)/iu.test(normalized) || /手机/iu.test(query)) {
    return ["00E"];
  }

  return [];
}

function sortByNearby(devices: NormalizedDeviceInfo[]): NormalizedDeviceInfo[] {
  return [...devices].sort((a, b) => Number(b.nearby) - Number(a.nearby));
}

function recommendDevices(
  query: string,
  devices: NormalizedDeviceInfo[],
): { recommendedDevices: NormalizedDeviceInfo[]; recommendationReason: string } {
  const desiredTypes = inferDesiredDeviceTypes(query);

  if (desiredTypes.length === 0) {
    return {
      recommendedDevices: [],
      recommendationReason: "No explicit target device type was detected in the query.",
    };
  }

  const matches = devices.filter((device) => desiredTypes.includes(device.deviceType));
  if (matches.length === 0) {
    return {
      recommendedDevices: [],
      recommendationReason: `No discovered device matches requested type(s): ${desiredTypes.join(", ")}.`,
    };
  }

  return {
    recommendedDevices: sortByNearby(matches),
    recommendationReason: `Matched requested device type(s): ${desiredTypes.join(", ")}. Nearby devices are ranked first.`,
  };
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

export const discoverCrossDevicesTool: any = {
  name: "discover_cross_devices",
  label: "发现跨设备协作设备",
  description: `跨设备协作的设备发现工具。

当用户明确表达要从另一台设备获取、查找、使用或操作内容时，必须优先调用本工具，例如：
- 从 PC、电脑、台式机、笔记本获取文件或查找资料
- 在平板上查找文件、照片、日程、备忘录等内容
- 从手机获取照片、文件、消息或其他本地数据
- 用户提到“另一台设备”“其他设备”“跨设备”“副设备”等协作意图

本工具会查询当前账号下可用的手机、平板、台式机、笔记本等设备列表，并根据用户原始需求给出候选目标设备和浅层推荐。
本工具只做设备发现和目标设备推荐，不会读取副设备文件内容，不会上传文件，也不会真正下发跨端执行任务。

如果用户只是操作当前设备，或没有明确跨设备意图，不要调用本工具。`,
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "The user's original cross-device request, used to recommend the target device type.",
      },
    },
    required: ["query"],
  },

  async execute(_toolCallId: string, params: any) {
    const query = typeof params.query === "string" ? params.query.trim() : "";
    if (!query) {
      return buildResultText({
        success: false,
        rawOutputs: null,
        devices: [],
        recommendedDevices: [],
        recommendationReason: "",
        message: "Missing required parameter: query.",
      });
    }

    const sessionContext = getCurrentSessionContext();
    if (!sessionContext) {
      return buildResultText({
        success: false,
        rawOutputs: null,
        devices: [],
        recommendedDevices: [],
        recommendationReason: "",
        message: "No active XY session found. Device discovery can only run during an active conversation.",
      });
    }

    const { config, sessionId } = sessionContext;
    const taskId = getCurrentTaskId(sessionId) ?? sessionContext.taskId;
    const messageId = getCurrentMessageId(sessionId) ?? sessionContext.messageId;
    const wsManager = getXYWebSocketManager(config);
    const command: A2ACommand = {
      header: {
        namespace: "Common",
        name: "Action",
      },
      payload: {
        needUploadResult: true,
        actionResponseConfig: {},
        response: [],
        executeParam: {
          executeMode: "background",
          intentName: DISCOVER_DEVICES_INTENT,
          intentParam: {},
          bundleName: DISCOVER_DEVICES_BUNDLE,
        },
      },
    };

    return new Promise((resolve) => {
      let timeout: NodeJS.Timeout;
      let handler: (event: A2ADataEvent) => void;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        wsManager.off("data-event", handler);
      };

      const finish = (result: Record<string, unknown>) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(buildResultText(result));
      };

      handler = (event: A2ADataEvent) => {
        if (event.intentName !== DISCOVER_DEVICES_INTENT) {
          return;
        }

        const rawOutputs = event.outputs ?? {};
        const code = rawOutputs.code;
        const success = event.status === "success" && String(code) === "0";
        const devices = normalizeDevices(rawOutputs.result?.devices);
        const recommendation = recommendDevices(query, devices);

        if (!success) {
          finish({
            success: false,
            rawOutputs,
            devices,
            recommendedDevices: recommendation.recommendedDevices,
            recommendationReason: recommendation.recommendationReason,
            message: "Device discovery failed on the device side.",
          });
          return;
        }

        finish({
          success: true,
          rawOutputs,
          devices,
          recommendedDevices: recommendation.recommendedDevices,
          recommendationReason: recommendation.recommendationReason,
          message: `Discovered ${devices.length} device(s). The model should choose the final target device based on the user request.`,
        });
      };

      timeout = setTimeout(() => {
        finish({
          success: false,
          rawOutputs: null,
          devices: [],
          recommendedDevices: [],
          recommendationReason: "",
          message: `Device discovery timed out after ${DISCOVER_DEVICES_TIMEOUT_MS / 1000} seconds.`,
        });
      }, DISCOVER_DEVICES_TIMEOUT_MS);

      wsManager.on("data-event", handler);

      sendStatusUpdate({
        config,
        sessionId,
        taskId,
        messageId,
        text: DISCOVER_DEVICES_STATUS_TEXT,
        state: "working",
      })
        .then(() =>
          sendCommand({
            config,
            sessionId,
            taskId,
            messageId,
            command,
          }),
        )
        .catch((error) => {
          finish({
            success: false,
            rawOutputs: null,
            devices: [],
            recommendedDevices: [],
            recommendationReason: "",
            message: `Failed to send device discovery command: ${error instanceof Error ? error.message : String(error)}`,
          });
        });
    });
  },
};

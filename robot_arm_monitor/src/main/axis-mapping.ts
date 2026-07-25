import Store from "electron-store";
import type { AxisMappingEntry, MappingSettings } from "../shared/types";

interface StoredAxisMapping {
  label: string;
  motorBoardId?: string;
  motorLocalAxis?: number;
  bridgeBoardId?: string;
  bridgeLocalChannel?: number;
}

interface SettingsSchema {
  axisMapping: Record<string, StoredAxisMapping>;
  boardLabels: Record<string, string>;
  pollingMs: { motor: number; bridge: number };
  gearMismatchThresholdDeg: number;
  gearMismatchCheckWhenMoving: boolean;
  graphWindowSeconds: number;
}

const defaults: SettingsSchema = {
  axisMapping: {},
  boardLabels: {},
  pollingMs: { motor: 100, bridge: 100 },
  gearMismatchThresholdDeg: 1,
  gearMismatchCheckWhenMoving: false,
  graphWindowSeconds: 60
};

export class AxisMappingStore {
  private readonly store = new Store<SettingsSchema>({
    name: "settings",
    defaults
  });

  get(): MappingSettings {
    const stored = this.store.get("axisMapping");
    const axisMapping = Object.entries(stored)
      .map(([axisId, mapping]) => ({ axisId: Number(axisId), ...mapping }))
      .filter(mapping => Number.isInteger(mapping.axisId) && mapping.axisId >= 1 && mapping.axisId <= 12)
      .sort((a, b) => a.axisId - b.axisId);
    return {
      axisMapping,
      boardLabels: { ...this.store.get("boardLabels") }
    };
  }

  set(value: MappingSettings): MappingSettings {
    const normalized = validateMappingSettings(value);
    const axisMapping: Record<string, StoredAxisMapping> = {};
    for (const mapping of normalized.axisMapping) {
      const { axisId, ...stored } = mapping;
      axisMapping[String(axisId)] = stored;
    }
    this.store.set("axisMapping", axisMapping);
    this.store.set("boardLabels", normalized.boardLabels);
    return normalized;
  }
}

export function validateMappingSettings(value: MappingSettings): MappingSettings {
  if (
    !value
    || !Array.isArray(value.axisMapping)
    || !value.boardLabels
    || typeof value.boardLabels !== "object"
    || Array.isArray(value.boardLabels)
  ) {
    throw new Error("Invalid mapping settings");
  }
  if (value.axisMapping.length > 12) throw new Error("A maximum of 12 logical axes is supported");

  const axisIds = new Set<number>();
  const motorAssignments = new Set<string>();
  const bridgeAssignments = new Set<string>();
  const axisMapping = value.axisMapping.map(mapping => {
    const axisId = Number(mapping.axisId);
    if (!Number.isInteger(axisId) || axisId < 1 || axisId > 12 || axisIds.has(axisId)) {
      throw new Error(`Invalid or duplicate logical axis: ${mapping.axisId}`);
    }
    axisIds.add(axisId);

    const label = String(mapping.label ?? "").trim().slice(0, 64);
    const motorBoardId = optionalId(mapping.motorBoardId);
    const bridgeBoardId = optionalId(mapping.bridgeBoardId);
    const motorLocalAxis = optionalChannel(mapping.motorLocalAxis, "motor local axis");
    const bridgeLocalChannel = optionalChannel(mapping.bridgeLocalChannel, "bridge local channel");
    requirePair(motorBoardId, motorLocalAxis, `Axis ${axisId} motor assignment`);
    requirePair(bridgeBoardId, bridgeLocalChannel, `Axis ${axisId} bridge assignment`);

    if (motorBoardId !== undefined && motorLocalAxis !== undefined) {
      const assignment = `${motorBoardId}:${motorLocalAxis}`;
      if (motorAssignments.has(assignment)) throw new Error(`Motor assignment is duplicated: ${assignment}`);
      motorAssignments.add(assignment);
    }
    if (bridgeBoardId !== undefined && bridgeLocalChannel !== undefined) {
      const assignment = `${bridgeBoardId}:${bridgeLocalChannel}`;
      if (bridgeAssignments.has(assignment)) throw new Error(`Bridge assignment is duplicated: ${assignment}`);
      bridgeAssignments.add(assignment);
    }

    return {
      axisId,
      label: label || `Axis ${axisId}`,
      ...(motorBoardId === undefined ? {} : { motorBoardId, motorLocalAxis }),
      ...(bridgeBoardId === undefined ? {} : { bridgeBoardId, bridgeLocalChannel })
    };
  }).sort((a, b) => a.axisId - b.axisId);

  const boardLabels: Record<string, string> = {};
  for (const [boardId, label] of Object.entries(value.boardLabels)) {
    const normalizedId = optionalId(boardId);
    if (!normalizedId) continue;
    if (normalizedId === "__proto__" || normalizedId === "constructor" || normalizedId === "prototype") {
      throw new Error("Invalid board ID");
    }
    boardLabels[normalizedId] = String(label ?? "").trim().slice(0, 64);
  }
  return { axisMapping, boardLabels };
}

function optionalId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const result = String(value).trim();
  if (!result || result.length > 128) throw new Error("Invalid board ID");
  return result;
}

function optionalChannel(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const result = Number(value);
  if (!Number.isInteger(result) || result < 0 || result > 2) throw new Error(`Invalid ${field}: ${value}`);
  return result;
}

function requirePair(boardId: string | undefined, channel: number | undefined, field: string): void {
  if ((boardId === undefined) !== (channel === undefined)) {
    throw new Error(`${field} requires both board ID and local channel`);
  }
}

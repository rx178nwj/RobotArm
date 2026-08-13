type AxisMappingEntry = import("../shared/types").AxisMappingEntry;
type BoardStatus = import("../shared/types").BoardStatus;
type BridgeConfigRefreshResult = import("../shared/types").BridgeConfigRefreshResult;
type BridgeLoggingState = import("../shared/types").BridgeLoggingState;
type BridgeMaintenanceRequest = import("../shared/types").BridgeMaintenanceRequest;
type BridgeMaintenanceResult = import("../shared/types").BridgeMaintenanceResult;
type BridgeSnapshot = import("../shared/types").BridgeSnapshot;
type CommandResult = import("../shared/types").CommandResult;
type ConnectResult = import("../shared/types").ConnectResult;
type ControlCommandRequest = import("../shared/types").ControlCommandRequest;
type ControlEvent = import("../shared/types").ControlEvent;
type CsvExportResult = import("../shared/types").CsvExportResult;
type DeviceSnapshot = import("../shared/types").DeviceSnapshot;
type EstopResult = import("../shared/types").EstopResult;
type FaultTraceCapture = import("../shared/types").FaultTraceCapture;
type MappingSettings = import("../shared/types").MappingSettings;
type PortInfo = import("../shared/types").PortInfo;
type RobotArmSnapshot = import("../shared/types").RobotArmSnapshot;
type AxisSnapshot = import("../shared/types").AxisSnapshot;
type MotorSnapshot = import("../shared/types").MotorSnapshot;
type SyncMoveAxisRequest = import("../shared/types").SyncMoveAxisRequest;

interface Window {
  uPlot: any;
  robotArmApi: {
    listPorts(): Promise<PortInfo[]>;
    connect(port: PortInfo): Promise<ConnectResult>;
    disconnect(boardId: string): Promise<void>;
    executeBridgeMaintenance(
      boardId: string,
      request: BridgeMaintenanceRequest
    ): Promise<BridgeMaintenanceResult>;
    refreshBridgeConfigs(): Promise<BridgeConfigRefreshResult[]>;
    getBridgeLoggingState(): Promise<BridgeLoggingState>;
    startBridgeLogging(): Promise<BridgeLoggingState>;
    stopBridgeLogging(): Promise<BridgeLoggingState>;
    exportRawLogs(): Promise<CsvExportResult>;
    getMappingSettings(): Promise<MappingSettings>;
    saveMappingSettings(settings: MappingSettings): Promise<MappingSettings>;
    getControlConnectionState(): Promise<boolean>;
    sendControlCommand(request: ControlCommandRequest): Promise<CommandResult>;
    sendSyncMove(requests: SyncMoveAxisRequest[]): Promise<CommandResult>;
    sendEstop(): Promise<EstopResult>;
    getRobotArmSnapshot(): Promise<RobotArmSnapshot>;
    getControlAppBoards(): Promise<BoardStatus[]>;
    onDeviceUpdate(callback: (snapshot: DeviceSnapshot) => void): () => void;
    onBridgeLoggingUpdate(callback: (state: BridgeLoggingState) => void): () => void;
    onControlConnectionChanged(callback: (connected: boolean) => void): () => void;
    onControlEvent(callback: (event: ControlEvent) => void): () => void;
    onRobotArmUpdate(callback: (snapshot: RobotArmSnapshot) => void): () => void;
    onControlAppBoardsChanged(callback: (boards: BoardStatus[]) => void): () => void;
    onFaultTrace(callback: (capture: FaultTraceCapture) => void): () => void;
  };
}

const devices = new Map<string, DeviceSnapshot>();
let ports = new Map<string, PortInfo>();
let selectedBoardId: string | undefined;
let displayedSnapshot: DeviceSnapshot | undefined;
let mappingSettings: MappingSettings = { axisMapping: [], boardLabels: {} };
let maintenanceBusy = false;
let configBusy = false;
let loggingState: BridgeLoggingState = { active: false, periodMs: 1000 };
let controlConnected = false;
let controlAppBoards: BoardStatus[] = [];
let knownControlAppBoardIds = new Set<string>();
let jogTimer: number | undefined;
let jogging = false;
let joggingAxis: number | undefined;
const verificationJogs = new Map<number, { timer: number; pointerId: number }>();
let verificationStructureSignature = "";
let deviceTabsSignature = "";
let robotSnapshot: RobotArmSnapshot = { axes: [], boards: [], controlAppConnected: false, timestamp: 0 };
let dashboardView: "summary" | "detail" | "comparison" | "boards" = "summary";
let trendDashboard: TrendCharts.RobotArmTrendDashboard;
let trendPaused = false;
let faultTraceViewer: FaultTracePanel.Viewer;
const faultTraceStore = new FaultTracePanel.Store();
let lastRawLogRenderAt = 0;
let configComparisonSignature = "";
let maintenanceSignature = "";
const controlEvents: Array<ControlEvent & { timestamp: number }> = [];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (value: unknown): string => String(value ?? "").replace(
  /[&<>"']/g,
  char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!
);

function setMessage(text: string, error = false): void {
  const element = $("message");
  element.textContent = text;
  element.className = error ? "message error" : "message";
}

function setMappingMessage(text: string, error = false): void {
  const element = $("mapping-message");
  element.textContent = text;
  element.className = error ? "message error" : "message";
}

function setMaintenanceMessage(text: string, error = false): void {
  const element = $("maintenance-message");
  element.textContent = text;
  element.className = error ? "message error" : "message";
}

function setConfigMessage(text: string, error = false): void {
  const element = $("config-message");
  element.textContent = text;
  element.className = error ? "message error" : "message";
}

function setLoggingMessage(text: string, error = false): void {
  const element = $("logging-message");
  element.textContent = text;
  element.className = error ? "message error" : "message";
}

function setControlMessage(text: string, error = false): void {
  const element = $("control-message");
  element.textContent = text;
  element.className = error ? "message error" : "message";
}

function renderControlPanel(): void {
  const state = $("control-state");
  state.textContent = controlConnected ? "制御アプリ接続済み" : "制御アプリ未接続";
  state.className = `state ${controlConnected ? "monitoring" : "disconnected"}`;
  const mappings = mappingSettings.axisMapping.filter(
    mapping => mapping.motorBoardId !== undefined && mapping.motorLocalAxis !== undefined
  );
  const select = $<HTMLSelectElement>("control-axis");
  const previous = Number(select.value);
  select.innerHTML = mappings.length
    ? mappings.map(mapping => `
      <option value="${mapping.axisId}" ${previous === mapping.axisId ? "selected" : ""}>
        ${esc(mapping.label || `Axis ${mapping.axisId}`)} · Axis ${mapping.axisId}
      </option>`).join("")
    : `<option value="">モーター割当なし</option>`;
  $<HTMLFieldSetElement>("control-fieldset").disabled = !controlConnected || mappings.length === 0;
  $<HTMLButtonElement>("control-estop").disabled = !controlConnected;
  const warning = $("global-control-warning");
  warning.textContent = controlConnected
    ? "制御アプリ接続済み · ESTOP中継可能"
    : "制御アプリ未接続 · ESTOP使用不可";
  warning.className = `global-control-warning ${controlConnected ? "connected" : ""}`;
  renderSyncMoveGroups(mappings);
  if (!controlConnected) {
    setControlMessage("制御アプリを起動すると操作パネルが有効になります。", true);
  } else if (!mappings.length) {
    setControlMessage("軸マッピングでMotor基板とローカル軸を割り当ててください。", true);
  } else if ($("control-message").classList.contains("error")) {
    setControlMessage("");
  }
}

function setThresholdMessage(text: string, error = false): void {
  const element = $("threshold-message");
  element.textContent = text;
  element.className = error ? "message error" : "message";
}

function thresholdMappings(): AxisMappingEntry[] {
  return mappingSettings.axisMapping.filter(
    mapping => mapping.motorBoardId !== undefined && mapping.motorLocalAxis !== undefined
  );
}

function selectedThresholdAxis(): number | undefined {
  const value = $<HTMLSelectElement>("threshold-axis").value;
  return value === "" ? undefined : Number(value);
}

function renderThresholdPanel(): void {
  const state = $("threshold-state");
  state.textContent = controlConnected ? "制御アプリ接続済み" : "制御アプリ未接続";
  state.className = `state ${controlConnected ? "monitoring" : "disconnected"}`;
  const mappings = thresholdMappings();
  const select = $<HTMLSelectElement>("threshold-axis");
  const previous = select.value;
  select.innerHTML = mappings.length
    ? mappings.map(mapping => `
      <option value="${mapping.axisId}">${esc(mapping.label || `Axis ${mapping.axisId}`)} · Axis ${mapping.axisId}</option>`).join("")
    : `<option value="">モーター割当なし</option>`;
  if (previous && mappings.some(mapping => String(mapping.axisId) === previous)) select.value = previous;
  const ready = controlConnected && mappings.length > 0;
  [
    "threshold-stall-refresh", "threshold-stall-set",
    "threshold-current-refresh", "threshold-current-set"
  ].forEach(id => { $<HTMLButtonElement>(id).disabled = !ready; });
  $<HTMLInputElement>("threshold-stall-input").disabled = !ready;
  $<HTMLInputElement>("threshold-current-input").disabled = !ready;
  if (!controlConnected) {
    setThresholdMessage("制御アプリを起動すると閾値の取得・変更ができます。", true);
  } else if (!mappings.length) {
    setThresholdMessage("軸マッピングでMotor基板とローカル軸を割り当ててください。", true);
  } else if ($("threshold-message").classList.contains("error")) {
    setThresholdMessage("");
  }
  updateThresholdLiveValues();
}

function updateThresholdLiveValues(): void {
  const axisId = selectedThresholdAxis();
  const axis = axisId === undefined ? undefined : robotSnapshot.axes.find(item => item.axisId === axisId);
  $("threshold-live-deviation").textContent = formatNumber(axis?.motor?.deviation, 0);
  $("threshold-live-state").textContent = axis?.motor?.state ?? "—";
  $("threshold-live-current").textContent = axis?.motor ? `${formatNumber(axis.motor.currentMa, 0)} mA` : "—";
}

async function thresholdGet(
  command: "GET_STALL_FAULT" | "GET_CURRENT_LIMIT",
  displayId: string
): Promise<void> {
  const axisId = selectedThresholdAxis();
  if (axisId === undefined) {
    setThresholdMessage("対象の論理軸を選択してください。", true);
    return;
  }
  try {
    const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command });
    if (result.ok) {
      $(displayId).textContent = result.message ?? "—";
      setThresholdMessage(`${command} · Axis ${axisId} → OK`);
    } else {
      setThresholdMessage(`${command} · Axis ${axisId} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`, true);
    }
  } catch (error) {
    setThresholdMessage(`${command}失敗: ${errorText(error)}`, true);
  }
}

async function thresholdSet(
  command: "SET_STALL_FAULT" | "SET_CURRENT_LIMIT",
  inputId: string,
  displayId: string
): Promise<void> {
  const axisId = selectedThresholdAxis();
  if (axisId === undefined) {
    setThresholdMessage("対象の論理軸を選択してください。", true);
    return;
  }
  const value = Number($<HTMLInputElement>(inputId).value);
  if (!Number.isFinite(value) || value < 0) {
    setThresholdMessage("0以上の数値を入力してください。", true);
    return;
  }
  try {
    const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command, args: [value] });
    if (result.ok) {
      $(displayId).textContent = String(value);
      setThresholdMessage(`${command} · Axis ${axisId} → OK`);
    } else {
      setThresholdMessage(`${command} · Axis ${axisId} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`, true);
    }
  } catch (error) {
    setThresholdMessage(`${command}失敗: ${errorText(error)}`, true);
  }
}

function setDriverSettingsMessage(text: string, error = false): void {
  const element = $("driver-settings-message");
  element.textContent = text;
  element.className = error ? "message error" : "message";
}

function driverSettingsMappings(): AxisMappingEntry[] {
  return thresholdMappings();
}

function selectedDriverSettingsAxis(): number | undefined {
  const value = $<HTMLSelectElement>("driver-settings-axis").value;
  return value === "" ? undefined : Number(value);
}

function renderDriverSettingsPanel(): void {
  const state = $("driver-settings-state");
  state.textContent = controlConnected ? "制御アプリ接続済み" : "制御アプリ未接続";
  state.className = `state ${controlConnected ? "monitoring" : "disconnected"}`;
  const mappings = driverSettingsMappings();
  const select = $<HTMLSelectElement>("driver-settings-axis");
  const previous = select.value;
  select.innerHTML = mappings.length
    ? mappings.map(mapping => `
      <option value="${mapping.axisId}">${esc(mapping.label || `Axis ${mapping.axisId}`)} · Axis ${mapping.axisId}</option>`).join("")
    : `<option value="">モーター割当なし</option>`;
  if (previous && mappings.some(mapping => String(mapping.axisId) === previous)) select.value = previous;
  const ready = controlConnected && mappings.length > 0;
  ["driver-microstep-refresh", "driver-microstep-set"].forEach(id => { $<HTMLButtonElement>(id).disabled = !ready; });
  $<HTMLSelectElement>("driver-microstep-input").disabled = !ready;
  if (!controlConnected) {
    setDriverSettingsMessage("制御アプリを起動すると設定の取得・変更ができます。", true);
  } else if (!mappings.length) {
    setDriverSettingsMessage("軸マッピングでMotor基板とローカル軸を割り当ててください。", true);
  } else if ($("driver-settings-message").classList.contains("error")) {
    setDriverSettingsMessage("");
  }
  renderGearRatioRows();
  renderMotionProfileRows();
}

async function driverMicrostepGet(): Promise<void> {
  const axisId = selectedDriverSettingsAxis();
  if (axisId === undefined) {
    setDriverSettingsMessage("対象の論理軸を選択してください。", true);
    return;
  }
  try {
    const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command: "GET_MICROSTEP" });
    if (result.ok) {
      $("driver-microstep-current").textContent = result.message ?? "—";
      if (result.message) $<HTMLSelectElement>("driver-microstep-input").value = result.message;
      setDriverSettingsMessage(`GET_MICROSTEP · Axis ${axisId} → OK`);
    } else {
      setDriverSettingsMessage(`GET_MICROSTEP · Axis ${axisId} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`, true);
    }
  } catch (error) {
    setDriverSettingsMessage(`GET_MICROSTEP失敗: ${errorText(error)}`, true);
  }
}

async function driverMicrostepSet(): Promise<void> {
  const axisId = selectedDriverSettingsAxis();
  if (axisId === undefined) {
    setDriverSettingsMessage("対象の論理軸を選択してください。", true);
    return;
  }
  const value = Number($<HTMLSelectElement>("driver-microstep-input").value);
  try {
    const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command: "SET_MICROSTEP", args: [value] });
    if (result.ok) {
      $("driver-microstep-current").textContent = String(value);
      setDriverSettingsMessage(`SET_MICROSTEP · Axis ${axisId} → OK`);
    } else {
      setDriverSettingsMessage(`SET_MICROSTEP · Axis ${axisId} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`, true);
    }
  } catch (error) {
    setDriverSettingsMessage(`SET_MICROSTEP失敗: ${errorText(error)}`, true);
  }
}

function renderGearRatioRows(): void {
  $("gear-ratio-rows").innerHTML = Array.from({ length: 12 }, (_, index) => {
    const axisId = index + 1;
    const mapping = verificationMapping(axisId);
    const assigned = mapping.motorBoardId !== undefined && mapping.motorLocalAxis !== undefined;
    const boardLabel = assigned ? (mappingSettings.boardLabels[mapping.motorBoardId!] || mapping.motorBoardId) : undefined;
    const disabledAttr = !controlConnected || !assigned ? "disabled" : "";
    return `
      <tr data-gear-ratio-row="${axisId}">
        <td><strong>${esc(mapping.label || `Axis ${axisId}`)}</strong><small>論理軸 ${axisId}</small></td>
        <td>${assigned ? `${esc(boardLabel)} / Axis ${mapping.motorLocalAxis}` : "未割当"}</td>
        <td><input data-gear-ratio-input="${axisId}" type="number" min="0.01" step="0.1" value="1" ${disabledAttr}></td>
        <td class="gear-ratio-actions">
          <button data-gear-ratio-get="${axisId}" ${disabledAttr}>取得</button>
          <button data-gear-ratio-set="${axisId}" ${disabledAttr}>設定</button>
          <button data-gear-ratio-save="${axisId}" ${disabledAttr}>NVS保存</button>
        </td>
      </tr>`;
  }).join("");
  bindGearRatioControls();
}

function bindGearRatioControls(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-gear-ratio-get]").forEach(button => {
    button.onclick = () => void gearRatioGet(Number(button.dataset.gearRatioGet));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-gear-ratio-set]").forEach(button => {
    button.onclick = () => void gearRatioSet(Number(button.dataset.gearRatioSet));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-gear-ratio-save]").forEach(button => {
    button.onclick = () => {
      const axisId = Number(button.dataset.gearRatioSave);
      if (window.confirm(`論理軸 ${axisId} の基板の設定（全軸分）をNVSに保存します。続行しますか？`)) {
        void sendJointCommand(axisId, "SAVE");
      }
    };
  });
}

async function gearRatioGet(axisId: number): Promise<void> {
  try {
    const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command: "GET_GEAR_RATIO" });
    if (result.ok && result.message) {
      const input = document.querySelector<HTMLInputElement>(`[data-gear-ratio-input="${axisId}"]`);
      if (input) input.value = result.message;
    }
    setDriverSettingsMessage(
      result.ok
        ? `GET_GEAR_RATIO · Axis ${axisId} → OK${result.message ? ` ${result.message}` : ""}`
        : `GET_GEAR_RATIO · Axis ${axisId} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`,
      !result.ok
    );
  } catch (error) {
    setDriverSettingsMessage(`GET_GEAR_RATIO失敗: ${errorText(error)}`, true);
  }
}

async function gearRatioSet(axisId: number): Promise<void> {
  const ratio = Number(document.querySelector<HTMLInputElement>(`[data-gear-ratio-input="${axisId}"]`)?.value);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    setDriverSettingsMessage("ギア比は0より大きい数値で入力してください。", true);
    return;
  }
  try {
    const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command: "SET_GEAR_RATIO", args: [ratio] });
    setDriverSettingsMessage(
      result.ok
        ? `SET_GEAR_RATIO · Axis ${axisId} → OK`
        : `SET_GEAR_RATIO · Axis ${axisId} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`,
      !result.ok
    );
  } catch (error) {
    setDriverSettingsMessage(`SET_GEAR_RATIO失敗: ${errorText(error)}`, true);
  }
}

function renderMotionProfileRows(): void {
  $("motion-profile-rows").innerHTML = Array.from({ length: 12 }, (_, index) => {
    const axisId = index + 1;
    const mapping = verificationMapping(axisId);
    const assigned = mapping.motorBoardId !== undefined && mapping.motorLocalAxis !== undefined;
    const boardLabel = assigned ? (mappingSettings.boardLabels[mapping.motorBoardId!] || mapping.motorBoardId) : undefined;
    const disabledAttr = !controlConnected || !assigned ? "disabled" : "";
    return `
      <tr data-motion-profile-row="${axisId}">
        <td><strong>${esc(mapping.label || `Axis ${axisId}`)}</strong><small>論理軸 ${axisId}</small></td>
        <td>${assigned ? `${esc(boardLabel)} / Axis ${mapping.motorLocalAxis}` : "未割当"}</td>
        <td><input data-motion-vmax="${axisId}" type="number" min="1" max="200000" step="1" ${disabledAttr}></td>
        <td><input data-motion-accel="${axisId}" type="number" min="1" step="1" ${disabledAttr}></td>
        <td><input data-motion-decel="${axisId}" type="number" min="1" step="1" ${disabledAttr}></td>
        <td class="motion-profile-actions">
          <button data-motion-get="${axisId}" ${disabledAttr}>取得</button>
          <button data-motion-set="${axisId}" ${disabledAttr}>設定</button>
        </td>
      </tr>`;
  }).join("");
  bindMotionProfileControls();
}

function bindMotionProfileControls(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-motion-get]").forEach(button => {
    button.onclick = () => void motionProfileGet(Number(button.dataset.motionGet));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-motion-set]").forEach(button => {
    button.onclick = () => void motionProfileSet(Number(button.dataset.motionSet));
  });
}

async function motionProfileGet(axisId: number): Promise<void> {
  const fields: Array<["GET_VMAX" | "GET_ACCEL" | "GET_DECEL", string]> = [
    ["GET_VMAX", "data-motion-vmax"], ["GET_ACCEL", "data-motion-accel"], ["GET_DECEL", "data-motion-decel"]
  ];
  for (const [command, attr] of fields) {
    try {
      const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command });
      if (result.ok && result.message) {
        const input = document.querySelector<HTMLInputElement>(`[${attr}="${axisId}"]`);
        if (input) input.value = result.message;
      } else if (!result.ok) {
        setDriverSettingsMessage(`${command} · Axis ${axisId} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`, true);
        return;
      }
    } catch (error) {
      setDriverSettingsMessage(`${command}失敗: ${errorText(error)}`, true);
      return;
    }
  }
  setDriverSettingsMessage(`モーションプロファイル取得 · Axis ${axisId} → OK`);
}

async function motionProfileSet(axisId: number): Promise<void> {
  const vmax = Number(document.querySelector<HTMLInputElement>(`[data-motion-vmax="${axisId}"]`)?.value);
  const accel = Number(document.querySelector<HTMLInputElement>(`[data-motion-accel="${axisId}"]`)?.value);
  const decel = Number(document.querySelector<HTMLInputElement>(`[data-motion-decel="${axisId}"]`)?.value);
  if (![vmax, accel, decel].every(value => Number.isFinite(value) && value > 0)) {
    setDriverSettingsMessage("VMAX/ACCEL/DECELはすべて0より大きい整数で入力してください。", true);
    return;
  }
  const steps: Array<[ControlCommandRequest["command"], number]> = [
    ["SET_VMAX", vmax], ["SET_ACCEL", accel], ["SET_DECEL", decel]
  ];
  for (const [command, value] of steps) {
    try {
      const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command, args: [value] });
      if (!result.ok) {
        setDriverSettingsMessage(`${command} · Axis ${axisId} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`, true);
        return;
      }
    } catch (error) {
      setDriverSettingsMessage(`${command}失敗: ${errorText(error)}`, true);
      return;
    }
  }
  setDriverSettingsMessage(`モーションプロファイル · Axis ${axisId} → OK`);
}

async function autoLoadDriverSettings(): Promise<void> {
  if (!controlConnected) return;
  const mappings = driverSettingsMappings();
  if (!mappings.length) return;
  const axisId = selectedDriverSettingsAxis() ?? mappings[0].axisId;
  try {
    const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command: "GET_MICROSTEP" });
    if (result.ok && result.message) {
      $("driver-microstep-current").textContent = result.message;
      $<HTMLSelectElement>("driver-microstep-input").value = result.message;
    }
  } catch {
    // Best-effort auto-load; manual refresh remains available if this fails.
  }
  for (const mapping of mappings) {
    try {
      const result = await window.robotArmApi.sendControlCommand({ logicalAxis: mapping.axisId, command: "GET_GEAR_RATIO" });
      if (result.ok && result.message) {
        const input = document.querySelector<HTMLInputElement>(`[data-gear-ratio-input="${mapping.axisId}"]`);
        if (input) input.value = result.message;
      }
    } catch {
      // Best-effort auto-load; manual refresh remains available if this fails.
    }
  }
  for (const mapping of mappings) {
    await motionProfileGet(mapping.axisId);
  }
}

function renderSyncMoveGroups(mappings: AxisMappingEntry[]): void {
  const byBoard = new Map<string, AxisMappingEntry[]>();
  for (const mapping of mappings) {
    const list = byBoard.get(mapping.motorBoardId!) ?? [];
    list.push(mapping);
    byBoard.set(mapping.motorBoardId!, list);
  }
  const groups = [...byBoard.entries()].filter(([, axes]) => axes.length >= 2);
  $("sync-move-groups").innerHTML = groups.length ? groups.map(([boardId, axes]) => `
    <div class="sync-board">
      <strong>${esc(mappingSettings.boardLabels[boardId] || boardId)}<small>${esc(boardId)}</small></strong>
      <div class="sync-axes">
        ${axes.map(axis => `
          <label class="sync-axis">
            <span><input type="checkbox" data-sync-check="${axis.axisId}"> ${esc(axis.label || `Axis ${axis.axisId}`)}</span>
            <input type="number" step="1" value="0" data-sync-steps="${axis.axisId}" aria-label="Axis ${axis.axisId} steps">
          </label>`).join("")}
      </div>
      <button data-sync-board="${esc(boardId)}">同期移動</button>
    </div>`).join("") : `<p class="empty">同一Motor基板に2軸以上を割り当てると操作できます。</p>`;
  document.querySelectorAll<HTMLButtonElement>("[data-sync-board]").forEach(button => {
    button.onclick = () => void executeSyncMove(button.dataset.syncBoard!);
  });
}

function selectedLogicalAxis(): number {
  const axis = Number($<HTMLSelectElement>("control-axis").value);
  if (!Number.isInteger(axis)) throw new Error("操作する論理軸を選択してください");
  return axis;
}

async function sendControlCommand(
  command: ControlCommandRequest["command"],
  args?: unknown[],
  logicalAxis = selectedLogicalAxis()
): Promise<CommandResult> {
  const result = await window.robotArmApi.sendControlCommand({ logicalAxis, command, args });
  setControlResult(`${command} · Axis ${logicalAxis}`, result);
  return result;
}

function setControlResult(operation: string, result: CommandResult): void {
  if (result.ok) {
    setControlMessage(`${operation} → OK`);
  } else {
    setControlMessage(
      `${operation} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`,
      true
    );
  }
}

async function executeControlButton(command: ControlCommandRequest["command"]): Promise<void> {
  try {
    await sendControlCommand(command);
  } catch (error) {
    setControlMessage(`${command}失敗: ${errorText(error)}`, true);
  }
}

async function executeMove(command: "MOVE" | "MOVETO", inputId: string): Promise<void> {
  const value = Number($<HTMLInputElement>(inputId).value);
  if (!Number.isSafeInteger(value)) {
    setControlMessage(`${command}の値は整数で入力してください。`, true);
    return;
  }
  try {
    await sendControlCommand(command, [value]);
  } catch (error) {
    setControlMessage(`${command}失敗: ${errorText(error)}`, true);
  }
}

function startJog(direction: -1 | 1): void {
  if (jogging || !controlConnected) return;
  const speed = Number($<HTMLInputElement>("jog-speed").value);
  if (!Number.isSafeInteger(speed) || speed <= 0) {
    setControlMessage("ジョグ速度は1以上の整数で入力してください。", true);
    return;
  }
  try {
    joggingAxis = selectedLogicalAxis();
  } catch (error) {
    setControlMessage(errorText(error), true);
    return;
  }
  jogging = true;
  const issueVel = (): void => {
    void sendControlCommand("VEL", [direction * speed], joggingAxis).catch(error => {
      setControlMessage(`VEL失敗: ${errorText(error)}`, true);
      stopJog(false);
    });
  };
  issueVel();
  jogTimer = window.setInterval(issueVel, 300);
}

function stopJog(sendStop = true): void {
  if (!jogging) return;
  jogging = false;
  if (jogTimer !== undefined) window.clearInterval(jogTimer);
  jogTimer = undefined;
  const axis = joggingAxis;
  joggingAxis = undefined;
  if (sendStop && axis !== undefined && controlConnected) {
    void sendControlCommand("STOP", undefined, axis).catch(error => {
      setControlMessage(`ジョグ停止失敗: ${errorText(error)}`, true);
    });
  }
}

function setJointCardMessage(axisId: number, text: string, error = false): void {
  const element = document.querySelector<HTMLElement>(`[data-verify-message="${axisId}"]`);
  if (!element) return;
  element.textContent = text;
  element.className = error ? "joint-card-message error" : "joint-card-message";
}

async function sendJointCommand(
  axisId: number,
  command: ControlCommandRequest["command"],
  args?: unknown[],
  ensureEnabled = false
): Promise<void> {
  try {
    if (ensureEnabled) {
      await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command: "ENABLE" });
    }
    const result = await window.robotArmApi.sendControlCommand({ logicalAxis: axisId, command, args });
    setJointCardMessage(
      axisId,
      result.ok
        ? `${command} → OK${result.message ? ` ${result.message}` : ""}`
        : `${command} → ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`,
      !result.ok
    );
  } catch (error) {
    setJointCardMessage(axisId, `${command}失敗: ${errorText(error)}`, true);
  }
}

function verificationMapping(axisId: number): AxisMappingEntry {
  return mappingSettings.axisMapping.find(item => item.axisId === axisId)
    ?? { axisId, label: `Axis ${axisId}` };
}

function renderJointVerificationPanel(forceStructure = false): void {
  const mappings = Array.from({ length: 12 }, (_, index) => verificationMapping(index + 1));
  const signature = JSON.stringify({
    controlConnected,
    axes: mappings.map(item => [item.axisId, item.label, item.motorBoardId, item.motorLocalAxis])
  });
  if (forceStructure || signature !== verificationStructureSignature) {
    stopAllVerificationJogs(false);
    verificationStructureSignature = signature;
    $("joint-verify-grid").innerHTML = mappings.map(mapping => {
      const assigned = mapping.motorBoardId !== undefined && mapping.motorLocalAxis !== undefined;
      const boardLabel = assigned
        ? mappingSettings.boardLabels[mapping.motorBoardId!] || mapping.motorBoardId
        : "未割当";
      return `
        <article class="joint-verify-card ${assigned ? "" : "unassigned"}" data-verify-card="${mapping.axisId}">
          <div class="joint-verify-heading">
            <div><h3>${esc(mapping.label || `Axis ${mapping.axisId}`)}</h3><small>論理軸 ${mapping.axisId}</small></div>
            <span class="joint-verify-assignment">${assigned ? `${esc(boardLabel)} / Axis ${mapping.motorLocalAxis}` : "未割当"}</span>
          </div>
          <dl class="joint-values">
            <div><dt>POT 生角度</dt><dd data-verify-value="${mapping.axisId}:potDegRaw">${assigned ? "未対応" : "未割当"}</dd></div>
            <div><dt>POT ゼロ補正</dt><dd data-verify-value="${mapping.axisId}:potDegZeroed">${assigned ? "未対応" : "未割当"}</dd></div>
            <div><dt>エンコーダ角度</dt><dd data-verify-value="${mapping.axisId}:encDeg">${assigned ? "未対応" : "未割当"}</dd></div>
            <div><dt>ドライバ角度</dt><dd data-verify-value="${mapping.axisId}:posDeg">${assigned ? "未対応" : "未割当"}</dd></div>
          </dl>
          <fieldset class="joint-verify-controls" ${!controlConnected || !assigned ? "disabled" : ""}>
            <button class="joint-recover-button" data-verify-recover="${mapping.axisId}">FAULT復帰（CLEAR_FAULT+ENABLE）</button>
            <div class="joint-mode-row"><label>操作モード</label><select data-verify-mode="${mapping.axisId}"><option value="angle">角度移動</option><option value="continuous">連続</option></select></div>
            <div data-verify-angle="${mapping.axisId}">
              <div class="joint-input-row"><label>刻み (°)</label><input data-verify-step="${mapping.axisId}" type="number" min="0.001" step="0.1" value="1"></div>
              <div class="joint-action-row"><button data-verify-move="-${mapping.axisId}">− 移動</button><button data-verify-move="${mapping.axisId}">＋ 移動</button></div>
            </div>
            <div data-verify-continuous="${mapping.axisId}" hidden>
              <div class="joint-input-row"><label>速度 (steps/s)</label><input data-verify-speed="${mapping.axisId}" type="number" min="1" step="1" value="1000"></div>
              <div class="joint-action-row"><button data-verify-jog="-${mapping.axisId}">− 押下中</button><button data-verify-jog="${mapping.axisId}">＋ 押下中</button></div>
            </div>
            <div class="joint-input-row"><label>絶対角度 (°)</label><input data-verify-target="${mapping.axisId}" type="number" step="0.1" value="0"></div>
            <button data-verify-moveto="${mapping.axisId}">MOVETO_DEG</button>
            <div class="joint-zero-row"><button data-verify-zero-set="${mapping.axisId}">POTゼロ設定</button><button data-verify-zero-clear="${mapping.axisId}">POTゼロ解除</button></div>
          </fieldset>
          <p class="joint-card-message" data-verify-message="${mapping.axisId}"></p>
        </article>`;
    }).join("");
    bindJointVerificationControls();
  }
  updateJointVerificationValues();
}

function updateJointVerificationValues(): void {
  for (let axisId = 1; axisId <= 12; axisId++) {
    const mapping = verificationMapping(axisId);
    const assigned = mapping.motorBoardId !== undefined && mapping.motorLocalAxis !== undefined;
    const joint = robotSnapshot.axes.find(axis => axis.axisId === axisId)?.jointAngle;
    for (const field of ["potDegRaw", "potDegZeroed", "encDeg", "posDeg"] as const) {
      const element = document.querySelector<HTMLElement>(`[data-verify-value="${axisId}:${field}"]`);
      if (!element) continue;
      const value = joint?.[field];
      element.textContent = !assigned ? "未割当" : value === null || value === undefined ? "未対応" : `${value.toFixed(3)}°`;
    }
  }
}

function bindJointVerificationControls(): void {
  document.querySelectorAll<HTMLSelectElement>("[data-verify-mode]").forEach(select => {
    select.onchange = () => {
      const axisId = Number(select.dataset.verifyMode);
      document.querySelector<HTMLElement>(`[data-verify-angle="${axisId}"]`)!.hidden = select.value !== "angle";
      document.querySelector<HTMLElement>(`[data-verify-continuous="${axisId}"]`)!.hidden = select.value !== "continuous";
      if (select.value !== "continuous") stopVerificationJog(axisId);
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-verify-move]").forEach(button => {
    button.onclick = () => {
      const signedAxis = Number(button.dataset.verifyMove);
      const axisId = Math.abs(signedAxis);
      const step = Number(document.querySelector<HTMLInputElement>(`[data-verify-step="${axisId}"]`)?.value);
      if (!Number.isFinite(step) || step <= 0) return setJointCardMessage(axisId, "刻み角度は0より大きい数値で入力してください。", true);
      void sendJointCommand(axisId, "MOVE_DEG", [Math.sign(signedAxis) * step], true);
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-verify-jog]").forEach(button => {
    button.onpointerdown = event => {
      event.preventDefault();
      const signedAxis = Number(button.dataset.verifyJog);
      startVerificationJog(Math.abs(signedAxis), Math.sign(signedAxis) as -1 | 1, event.pointerId);
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-verify-moveto]").forEach(button => {
    button.onclick = () => {
      const axisId = Number(button.dataset.verifyMoveto);
      const target = Number(document.querySelector<HTMLInputElement>(`[data-verify-target="${axisId}"]`)?.value);
      if (!Number.isFinite(target)) return setJointCardMessage(axisId, "絶対角度を数値で入力してください。", true);
      void sendJointCommand(axisId, "MOVETO_DEG", [target], true);
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-verify-recover]").forEach(button => {
    button.onclick = () => void sendJointCommand(Number(button.dataset.verifyRecover), "RECOVER");
  });
  document.querySelectorAll<HTMLButtonElement>("[data-verify-zero-set]").forEach(button => {
    button.onclick = () => {
      const axisId = Number(button.dataset.verifyZeroSet);
      if (window.confirm(`論理軸 ${axisId} の現在POT角度をゼロとして設定します。続行しますか？`)) {
        void sendJointCommand(axisId, "POT_ZERO_SET");
      }
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-verify-zero-clear]").forEach(button => {
    button.onclick = () => void sendJointCommand(Number(button.dataset.verifyZeroClear), "POT_ZERO_CLEAR");
  });
}

function startVerificationJog(axisId: number, direction: -1 | 1, pointerId: number): void {
  if (!controlConnected || verificationJogs.has(axisId)) return;
  const speed = Number(document.querySelector<HTMLInputElement>(`[data-verify-speed="${axisId}"]`)?.value);
  if (!Number.isSafeInteger(speed) || speed <= 0) {
    setJointCardMessage(axisId, "速度は1以上の整数で入力してください。", true);
    return;
  }
  const issue = (): void => void sendJointCommand(axisId, "VEL", [direction * speed], true);
  issue();
  verificationJogs.set(axisId, { timer: window.setInterval(issue, 300), pointerId });
}

function stopVerificationJog(axisId: number, sendStop = true): void {
  const jog = verificationJogs.get(axisId);
  if (!jog) return;
  window.clearInterval(jog.timer);
  verificationJogs.delete(axisId);
  if (sendStop && controlConnected) void sendJointCommand(axisId, "STOP");
}

function stopVerificationJogsForPointer(pointerId: number): void {
  for (const [axisId, jog] of verificationJogs) {
    if (jog.pointerId === pointerId) stopVerificationJog(axisId);
  }
}

function stopAllVerificationJogs(sendStop = true): void {
  for (const axisId of [...verificationJogs.keys()]) stopVerificationJog(axisId, sendStop);
}

async function executeSyncMove(boardId: string): Promise<void> {
  const mappings = mappingSettings.axisMapping.filter(mapping => mapping.motorBoardId === boardId);
  const requests: SyncMoveAxisRequest[] = mappings.flatMap(mapping => {
    const checked = document.querySelector<HTMLInputElement>(`[data-sync-check="${mapping.axisId}"]`)?.checked;
    if (!checked) return [];
    const value = Number(
      document.querySelector<HTMLInputElement>(`[data-sync-steps="${mapping.axisId}"]`)?.value
    );
    return [{ logicalAxis: mapping.axisId, steps: value }];
  });
  if (requests.length < 2 || requests.some(request => !Number.isSafeInteger(request.steps))) {
    setControlMessage("同一基板の2軸以上を選び、各移動量を整数で入力してください。", true);
    return;
  }
  try {
    const result = await window.robotArmApi.sendSyncMove(requests);
    setControlResult(`SYNC_MOVE · ${requests.map(request => `Axis ${request.logicalAxis}`).join(", ")}`, result);
  } catch (error) {
    setControlMessage(`SYNC_MOVE失敗: ${errorText(error)}`, true);
  }
}

async function executeEstop(): Promise<void> {
  if (!window.confirm("接続中の全SteppingMotorDriver基板へESTOPを送信します。続行しますか？")) return;
  const button = $<HTMLButtonElement>("control-estop");
  button.disabled = true;
  setControlMessage("全基板へのESTOP結果を待っています…");
  try {
    const result = await window.robotArmApi.sendEstop();
    renderEstopResults(result);
    const failed = result.results.filter(board => !board.ok).length;
    setControlMessage(
      `ESTOP完了: ${result.results.length - failed}/${result.results.length}基板成功`,
      failed > 0
    );
  } catch (error) {
    $("estop-results").innerHTML = "";
    setControlMessage(`ESTOP失敗: ${errorText(error)}`, true);
  } finally {
    button.disabled = !controlConnected;
  }
}

function renderEstopResults(result: EstopResult): void {
  $("estop-results").innerHTML = result.results.length ? result.results.map(board => `
    <div class="estop-result ${board.ok ? "ok" : "error"}">
      <span>${esc(mappingSettings.boardLabels[board.boardId] || board.boardId)}</span>
      <strong>${board.ok ? "OK" : `ERR ${esc(board.error ?? "UNKNOWN")}${board.message ? ` ${esc(board.message)}` : ""}`}</strong>
    </div>`).join("") : `<p class="empty">対象基板はありませんでした。</p>`;
}

function onControlConnectionChanged(connected: boolean): void {
  const becameConnected = connected && !controlConnected;
  controlConnected = connected;
  if (!connected) {
    stopJog(false);
    stopAllVerificationJogs(false);
  }
  renderControlPanel();
  renderThresholdPanel();
  renderDriverSettingsPanel();
  renderJointVerificationPanel();
  updateWindowTitle();
  if (becameConnected) void autoLoadDriverSettings();
}

function onRobotArmUpdate(snapshot: RobotArmSnapshot): void {
  robotSnapshot = snapshot;
  trendDashboard.add(snapshot);
  const becameConnected = snapshot.controlAppConnected && !controlConnected;
  const controlStateChanged = controlConnected !== snapshot.controlAppConnected;
  controlConnected = snapshot.controlAppConnected;
  if (controlStateChanged) { renderControlPanel(); renderThresholdPanel(); renderDriverSettingsPanel(); }
  updateThresholdLiveValues();
  renderIntegratedDashboard();
  renderJointVerificationPanel();
  updateWindowTitle();
  if (becameConnected) void autoLoadDriverSettings();
}

function renderIntegratedDashboard(): void {
  const boardById = new Map(robotSnapshot.boards.map(board => [board.boardId, board]));
  $("dashboard-boards").innerHTML = robotSnapshot.boards.length
    ? robotSnapshot.boards.map(board => `
      <span class="board-state ${esc(board.state)}" title="${esc(board.error ?? board.path)}">
        ${esc(board.label)} · ${board.kind === "stepping_motor_driver" ? "Motor" : "Bridge"}
      </span>`).join("")
    : `<span class="empty">接続基板なし</span>`;
  $("dashboard-updated").textContent = robotSnapshot.timestamp
    ? `最終更新 ${new Date(robotSnapshot.timestamp).toLocaleTimeString("ja-JP", { hour12: false, fractionalSecondDigits: 3 })}`
    : "データ待機中";
  if (dashboardView === "boards") {
    renderBoardRawCards();
    return;
  }
  if (dashboardView === "comparison") return;
  $("dashboard-axis-rows").innerHTML = robotSnapshot.axes.length
    ? robotSnapshot.axes.map((axis, index) => renderDashboardAxisRow(axis, index, boardById)).join("")
    : `<tr><td colspan="11" class="empty">軸マッピングを設定するか、基板を接続してください。</td></tr>`;
  document.querySelectorAll<HTMLTableRowElement>("[data-dashboard-axis]").forEach(row => {
    row.onclick = () => {
      const select = $<HTMLSelectElement>("dashboard-axis-select");
      select.value = row.dataset.dashboardAxis!;
      switchDashboardView("detail");
    };
  });
  const select = $<HTMLSelectElement>("dashboard-axis-select");
  const previous = select.value;
  select.innerHTML = robotSnapshot.axes.map((axis, index) =>
    `<option value="${index}">${esc(axis.axisLabel)}${axis.axisId === null ? " · 未割当" : ` · Axis ${axis.axisId}`}</option>`
  ).join("") || `<option value="">軸なし</option>`;
  if (previous && Number(previous) < robotSnapshot.axes.length) select.value = previous;
  renderAxisDetail();
  renderBoardRawCards();
  $("dashboard-updated").textContent = robotSnapshot.timestamp
    ? `最終更新 ${new Date(robotSnapshot.timestamp).toLocaleTimeString("ja-JP", { hour12: false, fractionalSecondDigits: 3 })}`
    : "データ待機中";
  renderErrorPanel();
}

function renderErrorPanel(): void {
  $("error-panel-grid").innerHTML = robotSnapshot.axes.length
    ? robotSnapshot.axes.map(renderErrorPanelCard).join("")
    : `<p class="empty">軸マッピングを設定するか、基板を接続してください。</p>`;
}

function renderErrorPanelCard(axis: AxisSnapshot): string {
  const faulted = Boolean(axis.motor?.errorCode);
  const commCell = (label: string, ok: boolean | undefined, text: string): string =>
    `<div><span class="comm-dot ${ok ? "ok" : "ng"}"></span>${esc(label)} <strong>${esc(text)}</strong></div>`;
  return `<article class="error-card ${faulted ? "faulted" : ""}">
    <h3>${esc(axis.axisLabel)}<small>${axis.axisId === null ? "未割当" : `Axis ${axis.axisId}`}</small></h3>
    <div class="error-row error-row-code">
      <div><span>Error Code</span><strong>${esc(axis.motor?.errorCode ?? "—")}</strong></div>
      <div><span>Error理由</span><strong>${esc(axis.motor?.errorReason ?? "正常")}</strong></div>
    </div>
    <div class="error-row error-row-angle">
      <div><span>センサ角度</span><strong>${formatAngle(axis.jointAngle?.potDegZeroed)}</strong></div>
      <div><span>エンコーダー角度</span><strong>${formatAngle(axis.jointAngle?.encDeg)}</strong></div>
    </div>
    <div class="error-row error-row-power">
      <div><span>PWM出力</span><strong>${axis.motor?.holdCurrentPercent === undefined ? "—" : `${axis.motor.holdCurrentPercent}%`}</strong></div>
      <div><span>電源電圧</span><strong>${formatNumber(axis.motor?.voltageV, 2)} V</strong></div>
      <div><span>電源電流</span><strong>${formatNumber(axis.motor?.currentMa, 0)} mA</strong></div>
    </div>
    <div class="error-row error-row-comm">
      ${commCell("I2C通信状態", axis.comm?.i2c === "OK", axis.comm?.i2c ?? "—")}
      ${commCell("USB通信状態", axis.comm?.usb === "monitoring", axis.comm?.usb ?? "—")}
      ${commCell("BLE通信状態", axis.comm?.ble === "CONNECTED", axis.comm?.ble ?? "—")}
    </div>
  </article>`;
}

function onFaultTrace(capture: FaultTraceCapture): void {
  faultTraceStore.add(capture);
  renderFaultTraceSelect();
  const select = $<HTMLSelectElement>("fault-trace-select");
  select.value = "0";
  renderFaultTraceSelected();
}

function renderFaultTraceSelect(): void {
  const select = $<HTMLSelectElement>("fault-trace-select");
  const previous = select.value;
  select.innerHTML = faultTraceStore.captures.length
    ? faultTraceStore.captures.map((capture, index) => {
        const time = new Date(capture.capturedAt).toLocaleTimeString("ja-JP", { hour12: false });
        const reason = capture.reason ? ` · ${capture.reason}` : "";
        return `<option value="${index}">${time} · ${esc(capture.axisLabel)}${esc(reason)}</option>`;
      }).join("")
    : `<option value="">キャプチャなし</option>`;
  if (previous && Number(previous) < faultTraceStore.captures.length) select.value = previous;
}

function renderFaultTraceSelected(): void {
  const value = $<HTMLSelectElement>("fault-trace-select").value;
  const summary = $("fault-trace-summary");
  const capture = value === "" ? undefined : faultTraceStore.get(Number(value));
  if (!capture) {
    summary.className = "fault-trace-summary empty";
    summary.textContent = "キャプチャを選択してください。";
    return;
  }
  summary.className = "fault-trace-summary";
  const time = new Date(capture.capturedAt).toLocaleTimeString("ja-JP", { hour12: false, fractionalSecondDigits: 3 });
  summary.innerHTML = [
    `<span>取得時刻</span>${esc(time)}`,
    `<span>軸</span>${esc(capture.axisLabel)}`,
    `<span>基板</span>${esc(capture.boardId)} / Axis ${capture.localAxis}`,
    `<span>理由</span>${esc(capture.reason ?? "—")}`,
    `<span>サンプル数</span>${capture.samples.length} 件 (${capture.intervalMs}ms間隔)`
  ].join("");
  faultTraceViewer.show(capture);
}

function renderDashboardAxisRow(
  axis: AxisSnapshot,
  index: number,
  boards: Map<string, RobotArmSnapshot["boards"][number]>
): string {
  const motorBoard = axis.motor ? boards.get(axis.motor.boardId) : undefined;
  const bridgeBoard = axis.gearDirect ? boards.get(axis.gearDirect.boardId) : undefined;
  const pcOk = Boolean(motorBoard?.state === "monitoring" || bridgeBoard?.state === "monitoring");
  const upperOk = axis.gearRelayed?.status === "OK" || Boolean(
    axis.gearDirect && devices.get(axis.gearDirect.boardId)?.kind === "multi_i2c_bridge"
      && (devices.get(axis.gearDirect.boardId) as BridgeSnapshot).master?.active
  );
  const sensorOk = axis.gearDirect?.ok ?? axis.gearRelayed?.status === "OK";
  const mismatch = axis.gearMismatch;
  return `<tr data-dashboard-axis="${index}" class="axis-summary-row ${mismatch?.exceeded ? "mismatch" : ""}">
    <td><strong>${esc(axis.axisLabel)}</strong><small>${axis.axisId === null ? "未割当" : `Axis ${axis.axisId}`}</small></td>
    <td><span class="axis-state ${esc((axis.motor?.state ?? "UNAVAILABLE").toLowerCase())}">${esc(axis.motor?.state ?? "—")}</span></td>
    <td>${formatNumber(axis.motor?.stepPos, 0)}</td><td>${formatNumber(axis.motor?.encoderPos, 0)}</td>
    <td>${formatNumber(axis.motor?.deviation, 0)}</td>
    <td>${formatAngle(axis.gearRelayed?.angleDeg)}<small>${esc(axis.gearRelayed?.status ?? "—")}</small></td>
    <td>${formatAngle(axis.gearDirect?.angleDeg)}<small>${axis.gearDirect ? `AGC ${axis.gearDirect.agc}` : "—"}</small></td>
    <td class="${mismatch?.exceeded ? "mismatch-value" : ""}">${mismatch ? `${formatNumber(mismatch.diffDeg, 2)}°` : axis.motor?.state && axis.motor.state !== "IDLE" ? "判定停止中" : "—"}</td>
    <td>${formatNumber(axis.motor?.currentMa, 0)} mA</td><td>${formatNumber(axis.motor?.voltageV, 2)} V</td>
    <td><span class="comm-dot ${pcOk ? "ok" : "ng"}" title="PC⇔基板"></span><span class="comm-dot ${upperOk ? "ok" : "ng"}" title="基板⇔上位I2C"></span><span class="comm-dot ${sensorOk ? "ok" : "ng"}" title="基板⇔センサI2C"></span></td>
  </tr>`;
}

function renderAxisDetail(): void {
  const index = Number($<HTMLSelectElement>("dashboard-axis-select").value);
  const axis = robotSnapshot.axes[index];
  if (!axis) {
    $("axis-detail-content").innerHTML = `<p class="empty">表示できる軸がありません。</p>`;
    return;
  }
  if (axis.axisId !== null) trendDashboard.setAxis(axis.axisId);
  const moving = axis.motor && axis.motor.state !== "IDLE";
  $("axis-detail-content").innerHTML = `
    <div class="axis-detail-grid">
      <article><h3>モーター</h3>${detailMetrics([
        ["状態", axis.motor?.state], ["ステップ位置", axis.motor?.stepPos],
        ["エンコーダ", axis.motor?.encoderPos], ["偏差", axis.motor?.deviation],
        ["速度", axis.motor?.velocity], ["電流", axis.motor ? `${axis.motor.currentMa} mA` : undefined],
        ["電圧", axis.motor ? `${axis.motor.voltageV.toFixed(2)} V` : undefined]
      ])}</article>
      <article class="${axis.gearMismatch?.exceeded ? "gear-warning" : ""}"><h3>ギア角度・突合</h3>${detailMetrics([
        ["中継値", axis.gearRelayed?.angleDeg == null ? undefined : `${axis.gearRelayed.angleDeg.toFixed(2)}°`],
        ["中継状態", axis.gearRelayed?.status],
        ["bridge直接値", axis.gearDirect?.angleDeg == null ? undefined : `${axis.gearDirect.angleDeg.toFixed(2)}°`],
        ["直接診断", axis.gearDirect ? `${axis.gearDirect.ok ? "OK" : "NOT OK"} · AGC ${axis.gearDirect.agc}` : undefined],
        ["差分", axis.gearMismatch ? `${axis.gearMismatch.diffDeg.toFixed(2)}°` : moving ? "動作中のため判定停止" : undefined],
        ["閾値", "1.00°（IDLE時のみ判定）"]
      ])}</article>
    </div>`;
}

function detailMetrics(rows: Array<[string, unknown]>): string {
  return `<dl class="detail-metrics">${rows.map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value ?? "—")}</dd></div>`).join("")}</dl>`;
}

function renderBoardRawCards(): void {
  const snapshots = [...devices.values()].sort((a, b) => a.boardId.localeCompare(b.boardId));
  $("board-raw-cards").innerHTML = snapshots.length ? snapshots.map(snapshot => {
    const label = mappingSettings.boardLabels[snapshot.boardId] || snapshot.boardId;
    if (snapshot.kind === "stepping_motor_driver") {
      const motor = snapshot as MotorSnapshot;
      return `<article class="board-raw-card"><h3>${esc(label)} <small>Motor · USB(制御アプリ)</small></h3>
        <table><thead><tr><th>Axis</th><th>State</th><th>Pos</th><th>Vel</th><th>Enc</th><th>Gear</th></tr></thead><tbody>${motor.axes.map(item => {
          const gear = motor.gear.find(value => value.axis === item.axis);
          return `<tr><td>${item.axis}</td><td>${esc(item.state)}</td><td>${item.pos}</td><td>${item.vel}</td><td>${item.enc}</td><td>${formatAngle(gear?.angleDeg)} · ${esc(gear?.state ?? "—")}</td></tr>`;
        }).join("")}</tbody></table></article>`;
    }
    const bridge = snapshot as BridgeSnapshot;
    return `<article class="board-raw-card"><h3>${esc(label)} <small>Bridge · USB</small></h3>
      <p>Status: ${bridge.status ? `samples ${bridge.status.samples} · fault ${hex(bridge.status.fault, 2)}` : "未取得"} / Master: ${bridge.master?.active ? "ACTIVE" : "IDLE"}</p>
      <table><thead><tr><th>CH</th><th>Present</th><th>Enable</th><th>OK</th><th>Degrees</th><th>AGC</th></tr></thead><tbody>${bridge.channels.map(channel => `<tr><td>${channel.channel}</td><td>${channel.present}</td><td>${channel.enable}</td><td>${channel.ok}</td><td>${formatAngle(channel.degrees)}</td><td>${channel.agc}</td></tr>`).join("")}</tbody></table></article>`;
  }).join("") : `<p class="empty">接続中の基板はありません。</p>`;
}

function formatNumber(value: number | undefined, digits: number): string {
  return value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);
}

function formatAngle(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `${value.toFixed(2)}°`;
}

function switchAppTab(tab: "connection" | "motor" | "monitor" | "threshold" | "settings"): void {
  $<HTMLElement>("tab-connection").hidden = tab !== "connection";
  $<HTMLElement>("tab-motor").hidden = tab !== "motor";
  $<HTMLElement>("tab-monitor").hidden = tab !== "monitor";
  $<HTMLElement>("tab-threshold").hidden = tab !== "threshold";
  $<HTMLElement>("tab-settings").hidden = tab !== "settings";
  document.querySelectorAll<HTMLButtonElement>("[data-app-tab]").forEach(button => {
    button.classList.toggle("active", button.dataset.appTab === tab);
  });
  if (tab === "threshold") renderThresholdPanel();
  if (tab === "settings") {
    renderDriverSettingsPanel();
    void autoLoadDriverSettings();
  }
}

function switchDashboardView(view: "summary" | "detail" | "comparison" | "boards"): void {
  dashboardView = view;
  $<HTMLElement>("dashboard-summary").hidden = view !== "summary";
  $<HTMLElement>("dashboard-detail").hidden = view !== "detail";
  $<HTMLElement>("dashboard-comparison").hidden = view !== "comparison";
  $<HTMLElement>("dashboard-board-view").hidden = view !== "boards";
  document.querySelectorAll<HTMLButtonElement>("[data-dashboard-view]").forEach(button => {
    button.classList.toggle("active", button.dataset.dashboardView === view);
  });
  if (view === "detail") renderAxisDetail();
  if (view === "boards") renderBoardRawCards();
  trendDashboard.setActiveViews(view === "detail", view === "comparison");
}

function onControlEvent(event: ControlEvent): void {
  controlEvents.unshift({ ...event, timestamp: Date.now() });
  controlEvents.splice(50);
  $("control-events").innerHTML = controlEvents.map(item => `
    <div class="control-event">
      <time>${new Date(item.timestamp).toLocaleTimeString("ja-JP", { hour12: false })}</time>
      <code>${esc(item.boardId)} · ${esc(item.event)}${item.axis === undefined ? "" : ` · local axis ${item.axis}`}</code>
    </div>`).join("");
}

async function refreshPorts(): Promise<void> {
  try {
    const list = await window.robotArmApi.listPorts();
    ports = new Map(list.map(port => [port.path, port]));
    const activePaths = new Set([...devices.values()].map(device => device.path));
    $("port-count").textContent = String(list.length);
    $("ports").innerHTML = list.length ? list.map(port => {
      const steppingMotor = port.kindHint === "stepping_motor_driver";
      const active = activePaths.has(port.path);
      const portType = port.candidate
        ? "bridge候補 · VID 2e8a"
        : steppingMotor
          ? "SteppingMotorDriver · 制御アプリで接続"
          : "その他";
      return `
      <article class="port ${port.candidate ? "candidate" : ""}">
        <div><strong>${esc(port.path)}</strong><small>${esc(port.manufacturer || "Serial device")}</small></div>
        <div class="port-actions">
          <span>${portType}</span>
          <button data-connect="${esc(port.path)}" ${active || steppingMotor ? "disabled" : ""}>
            ${active ? "接続済み" : steppingMotor ? "制御アプリを使用" : "接続"}
          </button>
        </div>
      </article>`;
    }).join("") : `<p class="empty">シリアルポートが見つかりません。</p>`;
    document.querySelectorAll<HTMLButtonElement>("[data-connect]").forEach(button => {
      button.onclick = () => void connect(button.dataset.connect!);
    });
  } catch (error) {
    $("ports").innerHTML = `<p class="empty">ポート一覧を取得できませんでした。</p>`;
    setMessage(`ポート検索エラー: ${errorText(error)}`, true);
  }
}

async function connect(path: string): Promise<void> {
  if (!path) {
    setMessage("接続するCOMポートを入力してください。", true);
    return;
  }
  const info = ports.get(path) ?? { path, friendlyName: path, candidate: false };
  if (info.kindHint === "stepping_motor_driver") {
    setMessage(`${path}はSteppingMotorDriverです。監視・モーション制御ともにControl Appから接続してください。`, true);
    return;
  }
  setMessage(`${path} で identity と status を確認しています…`);
  try {
    const result = await window.robotArmApi.connect(info);
    selectedBoardId = result.boardId;
    displayedSnapshot = devices.get(result.boardId);
    setMessage(`${path} に接続しました。`);
    renderDevices();
    renderSelectedDevice();
    renderMapping();
    renderConfigComparison();
  } catch (error) {
    for (const [boardId, snapshot] of devices) {
      if (snapshot.path === path && (snapshot.state === "error" || snapshot.state === "timeout")) {
        devices.delete(boardId);
      }
    }
    setMessage(`接続失敗: ${errorText(error)}`, true);
    renderDevices();
  } finally {
    await refreshPorts();
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error).replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function onDeviceUpdate(snapshot: DeviceSnapshot): void {
  let deviceSetChanged = false;
  let selectedDeviceChanged = false;
  if (snapshot.boardId !== "unidentified") {
    if (snapshot.state === "disconnected") {
      deviceSetChanged = devices.has(snapshot.boardId);
      devices.delete(snapshot.boardId);
      if (selectedBoardId === snapshot.boardId) {
        selectedBoardId = devices.keys().next().value as string | undefined;
        displayedSnapshot = selectedBoardId ? devices.get(selectedBoardId) : undefined;
        selectedDeviceChanged = true;
      }
    } else {
      deviceSetChanged = !devices.has(snapshot.boardId);
      devices.set(snapshot.boardId, snapshot);
      if (!selectedBoardId) {
        selectedBoardId = snapshot.boardId;
        selectedDeviceChanged = true;
      }
      if (selectedBoardId === snapshot.boardId) {
        displayedSnapshot = snapshot;
        selectedDeviceChanged = true;
      }
    }
  } else if (!selectedBoardId) {
    displayedSnapshot = snapshot;
    selectedDeviceChanged = true;
  }
  renderDevices();
  if (selectedDeviceChanged) renderSelectedDevice(false);
  if (deviceSetChanged) renderMapping();
  if (snapshot.kind === "multi_i2c_bridge") renderConfigComparison();
}

function renderDevices(): void {
  const connected = [...devices.values()].sort((a, b) => a.boardId.localeCompare(b.boardId));
  updateWindowTitle();
  const signature = connected.map(device => [
    device.boardId,
    mappingSettings.boardLabels[device.boardId] || device.boardId,
    device.kind,
    device.state,
    selectedBoardId === device.boardId ? "selected" : ""
  ].join(":")).join("|");
  if (signature === deviceTabsSignature) return;
  deviceTabsSignature = signature;
  $("devices").innerHTML = connected.length ? connected.map(device => `
    <button
      id="device-tab-${esc(device.boardId)}"
      class="device-button ${selectedBoardId === device.boardId ? "selected" : ""}"
      role="tab"
      aria-selected="${selectedBoardId === device.boardId}"
      aria-controls="device-tab-panel"
      tabindex="${selectedBoardId === device.boardId ? "0" : "-1"}"
      data-device="${esc(device.boardId)}"
    >
      <strong>${esc(mappingSettings.boardLabels[device.boardId] || device.boardId)}</strong>
      <small>${device.kind === "stepping_motor_driver" ? "Motor · USB(制御アプリ)" : "Bridge · USB"} · ${esc(device.state)}</small>
    </button>`).join("") : `<p class="empty">接続中の基板はありません。</p>`;
  document.querySelectorAll<HTMLButtonElement>("[data-device]").forEach(button => {
    button.onclick = () => selectDeviceTab(button.dataset.device);
    button.onkeydown = event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const index = connected.findIndex(device => device.boardId === button.dataset.device);
      const offset = event.key === "ArrowRight" ? 1 : -1;
      const next = connected[(index + offset + connected.length) % connected.length];
      selectDeviceTab(next?.boardId);
      document.querySelector<HTMLButtonElement>(`[data-device="${cssEscape(next?.boardId ?? "")}"]`)?.focus();
    };
  });
  const panel = $("device-tab-panel");
  const selectedTab = selectedBoardId ? document.getElementById(`device-tab-${selectedBoardId}`) : null;
  if (selectedTab) panel.setAttribute("aria-labelledby", selectedTab.id);
  else panel.removeAttribute("aria-labelledby");
}

function updateWindowTitle(): void {
  const controlState = controlConnected ? "制御接続" : "制御未接続";
  document.title = `Robot Arm Monitor (${devices.size} boards · ${controlState})`;
}

function selectDeviceTab(boardId: string | undefined): void {
  if (!boardId || !devices.has(boardId)) return;
  selectedBoardId = boardId;
  displayedSnapshot = devices.get(boardId);
  deviceTabsSignature = "";
  renderDevices();
  renderSelectedDevice();
  renderMaintenance();
  renderConfigComparison();
}

function cssEscape(value: string): string {
  return CSS.escape(value);
}

function renderConfigComparison(): void {
  const bridges = [...devices.values()]
    .filter((device): device is BridgeSnapshot => device.kind === "multi_i2c_bridge")
    .sort((a, b) => a.boardId.localeCompare(b.boardId));
  $<HTMLButtonElement>("refresh-config").disabled = configBusy || bridges.length === 0;
  const signature = JSON.stringify({
    configBusy,
    bridges: bridges.map(bridge => [
      bridge.boardId,
      mappingSettings.boardLabels[bridge.boardId] || bridge.boardId,
      bridge.config
    ])
  });
  if (signature === configComparisonSignature) return;
  configComparisonSignature = signature;
  $("config-rows").innerHTML = bridges.length ? bridges.map(bridge => {
    const config = bridge.config;
    return `
      <tr class="${config ? "" : "config-missing"}">
        <td><strong>${esc(mappingSettings.boardLabels[bridge.boardId] || bridge.boardId)}</strong><small>${esc(bridge.boardId)}</small></td>
        <td>${esc(config?.angleSrc ?? "未取得")}</td>
        <td>${esc(config?.pollPeriodMs ?? "—")}</td>
        <td>${esc(config?.statusDecim ?? "—")}</td>
        <td><code>${config ? hex(config.as5600Conf, 4) : "—"}</code></td>
        <td><code>${config ? hex(config.chEnable, 2) : "—"}</code></td>
        <td><code>${config ? hex(config.dirConfig, 2) : "—"}</code></td>
        <td><code>${config ? hex(config.dirApplied, 2) : "—"}</code></td>
      </tr>`;
  }).join("") : `<tr><td colspan="8" class="empty">接続中のbridgeはありません。</td></tr>`;
}

function hex(value: number, width: number): string {
  return `0x${value.toString(16).toUpperCase().padStart(width, "0")}`;
}

async function refreshBridgeConfigs(): Promise<void> {
  if (configBusy) return;
  configBusy = true;
  setConfigMessage("接続中のbridgeからconfigを取得しています…");
  renderConfigComparison();
  try {
    const results = await window.robotArmApi.refreshBridgeConfigs();
    const failures = results.filter(result => result.error);
    if (failures.length) {
      setConfigMessage(
        failures.map(result => `${result.boardId}: ${result.error}`).join(" / "),
        true
      );
    } else {
      setConfigMessage(`${results.length}基板のconfigを更新しました。`);
    }
  } catch (error) {
    setConfigMessage(`config取得失敗: ${errorText(error)}`, true);
  } finally {
    configBusy = false;
    renderConfigComparison();
  }
}

function renderLoggingState(): void {
  const state = $("logging-state");
  state.textContent = loggingState.active ? "記録中" : "停止中";
  state.className = `state ${loggingState.active ? "monitoring" : "disconnected"}`;
  $<HTMLButtonElement>("start-logging").disabled = loggingState.active;
  $<HTMLButtonElement>("stop-logging").disabled = !loggingState.active;
  $("logging-path").textContent = loggingState.filePath ?? "保存先未選択";
  if (loggingState.error) setLoggingMessage(loggingState.error, true);
}

function onBridgeLoggingUpdate(state: BridgeLoggingState): void {
  loggingState = state;
  renderLoggingState();
}

async function startBridgeLogging(): Promise<void> {
  setLoggingMessage("");
  try {
    loggingState = await window.robotArmApi.startBridgeLogging();
    if (loggingState.active) {
      setLoggingMessage(`CSVログ記録を開始しました（${loggingState.periodMs}ms周期）。`);
    } else if (!loggingState.canceled) {
      setLoggingMessage("CSVログ記録を開始できませんでした。", true);
    }
  } catch (error) {
    setLoggingMessage(`ログ開始失敗: ${errorText(error)}`, true);
  }
  renderLoggingState();
}

async function stopBridgeLogging(): Promise<void> {
  try {
    loggingState = await window.robotArmApi.stopBridgeLogging();
    setLoggingMessage(loggingState.error ? `ログ停止: ${loggingState.error}` : "CSVログ記録を停止しました。", Boolean(loggingState.error));
  } catch (error) {
    setLoggingMessage(`ログ停止失敗: ${errorText(error)}`, true);
  }
  renderLoggingState();
}

async function exportRawLogs(): Promise<void> {
  try {
    const result = await window.robotArmApi.exportRawLogs();
    if (!result.canceled) setLoggingMessage(`送受信ログを保存しました: ${result.filePath}`);
  } catch (error) {
    setLoggingMessage(`送受信ログのエクスポート失敗: ${errorText(error)}`, true);
  }
}

function renderSelectedDevice(forceLog = true): void {
  const snapshot = displayedSnapshot;
  const state = $("state");
  if (!snapshot) {
    state.textContent = "未接続";
    state.className = "state disconnected";
    $("identity").innerHTML = `<span>Board ID</span><strong>—</strong>`;
    $("status").innerHTML = emptyStatusHtml();
    $("log").innerHTML = `<p class="empty">接続するとログが表示されます。</p>`;
    $<HTMLButtonElement>("disconnect").disabled = true;
    renderMaintenance();
    return;
  }

  state.textContent = {
    disconnected: "未接続", connecting: "確認中", monitoring: "接続済み",
    timeout: "タイムアウト", error: "エラー"
  }[snapshot.state];
  state.className = `state ${snapshot.state}`;
  $("identity").innerHTML = `<span>Board ID</span><strong>${esc(snapshot.boardId)}</strong>`;
  const metrics = snapshot.metrics.slice(0, 4);
  $("status").innerHTML = `
    <div><span>Port</span><strong>${esc(snapshot.path)}</strong></div>
    <div><span>Protocol</span><strong>${esc(snapshot.protocolVersion ?? "—")}</strong></div>
    ${metrics.map(metric => `
      <div><span>${esc(metric.label)}</span><strong>${esc(metric.value)}</strong></div>
    `).join("")}`;
  $<HTMLButtonElement>("disconnect").disabled = !devices.has(snapshot.boardId);
  const now = performance.now();
  if (forceLog || now - lastRawLogRenderAt >= 500) {
    lastRawLogRenderAt = now;
    $("log").innerHTML = snapshot.rawLog.length ? snapshot.rawLog.map(entry => `
    <div class="log-line ${entry.direction}">
      <time>${new Date(entry.timestamp).toLocaleTimeString("ja-JP", { hour12: false, fractionalSecondDigits: 3 })}</time>
      <b>${entry.direction.toUpperCase()}</b>
      <code>${esc(entry.text)}</code>
    </div>`).join("") : `<p class="empty">ログはまだありません。</p>`;
    $("log").scrollTop = $("log").scrollHeight;
  }
  if (snapshot.error) setMessage(snapshot.error, true);
  renderMaintenance();
}

function renderMaintenance(): void {
  const snapshot = displayedSnapshot?.kind === "multi_i2c_bridge"
    && devices.has(displayedSnapshot.boardId)
    ? displayedSnapshot as BridgeSnapshot
    : undefined;
  $("maintenance-target").textContent = snapshot
    ? mappingSettings.boardLabels[snapshot.boardId] || snapshot.boardId
    : "基板未選択";
  document.querySelectorAll<HTMLButtonElement>("[data-maintenance]").forEach(button => {
    button.disabled = !snapshot || maintenanceBusy;
  });
  const channels = new Map(snapshot?.channels.map(channel => [channel.channel, channel]) ?? []);
  const nextMaintenanceSignature = JSON.stringify({
    boardId: snapshot?.boardId,
    label: snapshot ? mappingSettings.boardLabels[snapshot.boardId] : undefined,
    maintenanceBusy,
    channels: [...channels.values()].map(channel => [
      channel.channel, channel.present, channel.enable, channel.ok, channel.dirConfig
    ])
  });
  if (nextMaintenanceSignature === maintenanceSignature) return;
  maintenanceSignature = nextMaintenanceSignature;
  const enabledCount = [...channels.values()].filter(channel => channel.enable).length;
  $("maintenance-channels").innerHTML = Array.from({ length: 6 }, (_, channel) => {
    const data = channels.get(channel);
    const enabled = data?.enable;
    const direction = data?.dirConfig;
    return `
      <div class="maintenance-channel">
        <strong>CH ${channel}</strong>
        <span>${data ? `${data.present ? "PRESENT" : "ABSENT"} · ${data.ok ? "OK" : "NOT OK"}` : "状態未取得"}</span>
        <div class="channel-actions">
          <button data-channel-enable="${channel}" class="${enabled === true ? "active" : ""}" ${!snapshot || maintenanceBusy ? "disabled" : ""}>Enable</button>
          <button
            data-channel-disable="${channel}"
            class="${enabled === false ? "active" : ""}"
            ${!snapshot || maintenanceBusy || (enabled === true && enabledCount <= 1) ? "disabled" : ""}
            title="${enabled === true && enabledCount <= 1 ? "全チャンネル無効化を防ぐため操作できません" : ""}"
          >Disable</button>
          <button data-channel-dir="${channel}" data-direction="0" class="${direction === false ? "active" : ""}" ${!snapshot || maintenanceBusy ? "disabled" : ""}>DIR 0</button>
          <button data-channel-dir="${channel}" data-direction="1" class="${direction === true ? "active" : ""}" ${!snapshot || maintenanceBusy ? "disabled" : ""}>DIR 1</button>
          <button data-channel-zero-set="${channel}" class="caution" ${!snapshot || maintenanceBusy ? "disabled" : ""}>0位置設定</button>
          <button data-channel-zero-clear="${channel}" ${!snapshot || maintenanceBusy ? "disabled" : ""}>0位置クリア</button>
        </div>
      </div>`;
  }).join("");
  document.querySelectorAll<HTMLButtonElement>("[data-channel-enable]").forEach(button => {
    button.onclick = () => void executeMaintenance({
      action: "channel_enable",
      channel: Number(button.dataset.channelEnable)
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-channel-disable]").forEach(button => {
    button.onclick = () => void executeMaintenance({
      action: "channel_disable",
      channel: Number(button.dataset.channelDisable)
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-channel-dir]").forEach(button => {
    button.onclick = () => void executeMaintenance({
      action: "channel_direction",
      channel: Number(button.dataset.channelDir),
      direction: Number(button.dataset.direction) as 0 | 1
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-channel-zero-set]").forEach(button => {
    button.onclick = () => void executeMaintenance({
      action: "channel_zero_set",
      channel: Number(button.dataset.channelZeroSet)
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-channel-zero-clear]").forEach(button => {
    button.onclick = () => void executeMaintenance({
      action: "channel_zero_clear",
      channel: Number(button.dataset.channelZeroClear)
    });
  });
}

async function executeMaintenance(request: BridgeMaintenanceRequest): Promise<void> {
  const snapshot = displayedSnapshot;
  if (!snapshot || snapshot.kind !== "multi_i2c_bridge" || !devices.has(snapshot.boardId)) {
    setMaintenanceMessage("接続中のbridgeを選択してください。", true);
    return;
  }
  const confirmation = maintenanceConfirmation(request);
  if (confirmation && !window.confirm(confirmation)) return;
  maintenanceBusy = true;
  setMaintenanceMessage("コマンド応答を待っています…");
  renderMaintenance();
  try {
    const result = await window.robotArmApi.executeBridgeMaintenance(snapshot.boardId, request);
    setMaintenanceMessage(`${result.command} → ${result.response}`);
  } catch (error) {
    setMaintenanceMessage(`保守コマンド失敗: ${errorText(error)}`, true);
  } finally {
    maintenanceBusy = false;
    renderMaintenance();
  }
}

function maintenanceConfirmation(request: BridgeMaintenanceRequest): string | undefined {
  switch (request.action) {
    case "channel_direction":
      return `CH ${request.channel} のDIRを ${request.direction} に変更します。角度出力が不連続になる可能性があります。実行しますか？`;
    case "channel_zero_set":
      return `CH ${request.channel} の現在位置を0位置として設定します。既存の0位置設定は上書きされます。実行しますか？`;
    case "mux_reset":
      return "TCA9548Aをハードウェアリセットし、下流センサを再初期化します。実行しますか？";
    case "reboot":
      return "選択中のbridgeを再起動します。USB接続が切断されます。実行しますか？";
    default:
      return undefined;
  }
}

function emptyStatusHtml(): string {
  return `
    <div><span>Port</span><strong>—</strong></div>
    <div><span>Protocol</span><strong>—</strong></div>
    <div><span>Status</span><strong>—</strong></div>
    <div><span>Last update</span><strong>—</strong></div>`;
}

function renderMapping(): void {
  const mappings = new Map(mappingSettings.axisMapping.map(mapping => [mapping.axisId, mapping]));
  $("mapping-rows").innerHTML = Array.from({ length: 12 }, (_, index) => {
    const axisId = index + 1;
    const mapping = mappings.get(axisId);
    const assigned = Boolean(mapping?.motorBoardId || mapping?.bridgeBoardId);
    return `
      <tr class="${assigned ? "" : "unmapped"}" data-axis-row="${axisId}">
        <td><strong>Axis ${axisId}</strong></td>
        <td><input data-axis-label="${axisId}" value="${esc(mapping?.label ?? "")}" placeholder="J${axisId}"></td>
        <td><select data-motor-board="${axisId}">${boardOptions("stepping_motor_driver", mapping?.motorBoardId)}</select></td>
        <td><select class="channel" data-motor-axis="${axisId}">${channelOptions(mapping?.motorLocalAxis)}</select></td>
        <td><select data-bridge-board="${axisId}">${boardOptions("multi_i2c_bridge", mapping?.bridgeBoardId)}</select></td>
        <td><select class="channel" data-bridge-channel="${axisId}">${channelOptions(mapping?.bridgeLocalChannel)}</select></td>
        <td><select class="channel" data-gear-dir="${axisId}"><option value="1" ${mapping?.gearDirSign !== -1 ? "selected" : ""}>+1</option><option value="-1" ${mapping?.gearDirSign === -1 ? "selected" : ""}>−1</option></select></td>
        <td><input class="channel" type="number" min="-360" max="360" step="0.01" data-gear-offset="${axisId}" value="${mapping?.gearAngleOffset ?? 0}"></td>
      </tr>`;
  }).join("");

  const knownBoardIds = collectKnownBoardIds();
  $("board-labels").innerHTML = knownBoardIds.length ? knownBoardIds.map(boardId => `
    <label class="board-label">
      <code title="${esc(boardId)}">${esc(boardId)}</code>
      <input data-board-label="${esc(boardId)}" value="${esc(mappingSettings.boardLabels[boardId] ?? "")}" placeholder="基板表示名">
    </label>`).join("") : `<p class="empty">基板接続後に基板ラベルを設定できます。</p>`;

  document.querySelectorAll<HTMLSelectElement>("[data-motor-board], [data-bridge-board]").forEach(select => {
    select.onchange = updateUnmappedRows;
  });
}

function boardOptions(kind: DeviceSnapshot["kind"], selected?: string): string {
  const boardIds = new Set<string>();
  if (kind === "stepping_motor_driver") {
    // Motor boards are selected by their USB identity in control_app; telemetry arrives
    // automatically via the control_app IPC connection for any board it has connected.
    for (const board of controlAppBoards) boardIds.add(board.boardId);
  } else {
    for (const device of devices.values()) if (device.kind === kind) boardIds.add(device.boardId);
  }
  for (const mapping of mappingSettings.axisMapping) {
    const boardId = kind === "multi_i2c_bridge" ? mapping.bridgeBoardId : mapping.motorBoardId;
    if (boardId) boardIds.add(boardId);
  }
  if (selected) boardIds.add(selected);
  return [
    `<option value="">未割当</option>`,
    ...[...boardIds].sort().map(boardId => `
      <option value="${esc(boardId)}" ${selected === boardId ? "selected" : ""}>
        ${esc(mappingSettings.boardLabels[boardId] || boardId)}${esc(boardStatusSuffix(kind, boardId))}
      </option>`)
  ].join("");
}

function boardStatusSuffix(kind: DeviceSnapshot["kind"], boardId: string): string {
  if (kind !== "stepping_motor_driver") return "";
  const device = devices.get(boardId);
  if (device?.kind === "stepping_motor_driver" && device.state === "monitoring") return " (テレメトリ受信中)";
  if (controlAppBoards.some(board => board.boardId === boardId)) return " (USB検出/テレメトリ待ち)";
  return " (未接続)";
}

function channelOptions(selected?: number): string {
  return [
    `<option value="">—</option>`,
    ...[0, 1, 2].map(channel => `<option value="${channel}" ${selected === channel ? "selected" : ""}>${channel}</option>`)
  ].join("");
}

function collectKnownBoardIds(): string[] {
  const result = new Set<string>(Object.keys(mappingSettings.boardLabels));
  for (const device of devices.values()) result.add(device.boardId);
  for (const board of controlAppBoards) result.add(board.boardId);
  for (const mapping of mappingSettings.axisMapping) {
    if (mapping.motorBoardId) result.add(mapping.motorBoardId);
    if (mapping.bridgeBoardId) result.add(mapping.bridgeBoardId);
  }
  return [...result].sort();
}

function updateUnmappedRows(): void {
  document.querySelectorAll<HTMLTableRowElement>("[data-axis-row]").forEach(row => {
    const axisId = row.dataset.axisRow!;
    const motor = document.querySelector<HTMLSelectElement>(`[data-motor-board="${axisId}"]`)?.value;
    const bridge = document.querySelector<HTMLSelectElement>(`[data-bridge-board="${axisId}"]`)?.value;
    row.classList.toggle("unmapped", !motor && !bridge);
  });
}

async function saveMapping(): Promise<void> {
  const axisMapping: AxisMappingEntry[] = Array.from({ length: 12 }, (_, index) => {
    const axisId = index + 1;
    const labelElement = document.querySelector<HTMLInputElement>(`[data-axis-label="${axisId}"]`)!;
    const motorBoardId = document.querySelector<HTMLSelectElement>(`[data-motor-board="${axisId}"]`)!.value;
    const motorAxis = document.querySelector<HTMLSelectElement>(`[data-motor-axis="${axisId}"]`)!.value;
    const bridgeBoardId = document.querySelector<HTMLSelectElement>(`[data-bridge-board="${axisId}"]`)!.value;
    const bridgeChannel = document.querySelector<HTMLSelectElement>(`[data-bridge-channel="${axisId}"]`)!.value;
    const gearDirSign = Number(document.querySelector<HTMLSelectElement>(`[data-gear-dir="${axisId}"]`)!.value) as -1 | 1;
    const gearAngleOffset = Number(document.querySelector<HTMLInputElement>(`[data-gear-offset="${axisId}"]`)!.value);
    return {
      axisId,
      label: labelElement.value.trim() || `Axis ${axisId}`,
      ...(motorBoardId ? {
        motorBoardId,
        ...(motorAxis === "" ? {} : { motorLocalAxis: Number(motorAxis) })
      } : {}),
      ...(bridgeBoardId ? {
        bridgeBoardId,
        ...(bridgeChannel === "" ? {} : { bridgeLocalChannel: Number(bridgeChannel) }),
        gearDirSign,
        gearAngleOffset
      } : {})
    };
  });
  const boardLabels: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>("[data-board-label]").forEach(input => {
    boardLabels[input.dataset.boardLabel!] = input.value.trim();
  });
  const incomplete = axisMapping.find(
    mapping =>
      (mapping.motorBoardId !== undefined) !== (mapping.motorLocalAxis !== undefined)
      || (mapping.bridgeBoardId !== undefined) !== (mapping.bridgeLocalChannel !== undefined)
  );
  if (incomplete) {
    setMappingMessage(`Axis ${incomplete.axisId}: 基板を選んだ側は「軸」または「CH」も選択してください。`, true);
    return;
  }
  try {
    mappingSettings = await window.robotArmApi.saveMappingSettings({ axisMapping, boardLabels });
    robotSnapshot = await window.robotArmApi.getRobotArmSnapshot();
    setMappingMessage("軸マッピングを保存しました。");
    renderDevices();
    renderMapping();
    renderConfigComparison();
    renderControlPanel();
    renderThresholdPanel();
    renderDriverSettingsPanel();
    renderJointVerificationPanel(true);
    renderIntegratedDashboard();
  } catch (error) {
    setMappingMessage(`保存失敗: ${errorText(error)}`, true);
  }
}

async function init(): Promise<void> {
  trendDashboard = new TrendCharts.RobotArmTrendDashboard(window.uPlot, {
    velocity: $("trend-velocity"),
    position: $("trend-position"),
    deviation: $("trend-deviation"),
    power: $("trend-power"),
    gear: $("trend-gear"),
    comparison: $("trend-comparison")
  });
  faultTraceViewer = new FaultTracePanel.Viewer(window.uPlot, {
    position: $("fault-trace-position"),
    diff: $("fault-trace-diff"),
    velocity: $("fault-trace-velocity"),
    current: $("fault-trace-current")
  });
  $<HTMLSelectElement>("fault-trace-select").onchange = () => renderFaultTraceSelected();
  window.robotArmApi.onFaultTrace(onFaultTrace);
  window.robotArmApi.onDeviceUpdate(onDeviceUpdate);
  window.robotArmApi.onBridgeLoggingUpdate(onBridgeLoggingUpdate);
  window.robotArmApi.onControlConnectionChanged(onControlConnectionChanged);
  window.robotArmApi.onControlEvent(onControlEvent);
  window.robotArmApi.onRobotArmUpdate(onRobotArmUpdate);
  window.robotArmApi.onControlAppBoardsChanged(boards => {
    const boardIds = new Set(boards.map(board => board.boardId));
    const newlyConnected = [...boardIds].some(boardId => !knownControlAppBoardIds.has(boardId));
    knownControlAppBoardIds = boardIds;
    controlAppBoards = boards;
    renderMapping();
    renderDriverSettingsPanel();
    if (newlyConnected) void autoLoadDriverSettings();
  });
  $("refresh").onclick = () => void refreshPorts();
  $("manual-connect").onclick = () => void connect($<HTMLInputElement>("manual-port").value.trim());
  $("save-mapping").onclick = () => void saveMapping();
  $("refresh-config").onclick = () => void refreshBridgeConfigs();
  $("start-logging").onclick = () => void startBridgeLogging();
  $("stop-logging").onclick = () => void stopBridgeLogging();
  $("export-raw-log").onclick = () => void exportRawLogs();
  document.querySelectorAll<HTMLButtonElement>("[data-control-command]").forEach(button => {
    button.onclick = () => void executeControlButton(
      button.dataset.controlCommand as ControlCommandRequest["command"]
    );
  });
  $("send-move").onclick = () => void executeMove("MOVE", "move-steps");
  $("send-moveto").onclick = () => void executeMove("MOVETO", "moveto-position");
  $("control-estop").onclick = () => void executeEstop();
  $("threshold-axis").onchange = () => updateThresholdLiveValues();
  $("threshold-stall-refresh").onclick = () => void thresholdGet("GET_STALL_FAULT", "threshold-stall-current");
  $("threshold-stall-set").onclick = () => void thresholdSet("SET_STALL_FAULT", "threshold-stall-input", "threshold-stall-current");
  $("threshold-current-refresh").onclick = () => void thresholdGet("GET_CURRENT_LIMIT", "threshold-current-current");
  $("threshold-current-set").onclick = () => void thresholdSet("SET_CURRENT_LIMIT", "threshold-current-input", "threshold-current-current");
  $("driver-microstep-refresh").onclick = () => void driverMicrostepGet();
  $("driver-microstep-set").onclick = () => void driverMicrostepSet();
  $("dashboard-axis-select").onchange = () => renderAxisDetail();
  document.querySelectorAll<HTMLButtonElement>("[data-dashboard-view]").forEach(button => {
    button.onclick = () => switchDashboardView(button.dataset.dashboardView as typeof dashboardView);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-app-tab]").forEach(button => {
    button.onclick = () => switchAppTab(button.dataset.appTab as Parameters<typeof switchAppTab>[0]);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-trend-window]").forEach(button => {
    button.onclick = () => {
      const seconds = Number(button.dataset.trendWindow);
      trendDashboard.setWindow(seconds);
      document.querySelectorAll<HTMLButtonElement>("[data-trend-window]").forEach(item => {
        item.classList.toggle("active", item === button);
      });
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-trend-pause]").forEach(button => {
    button.onclick = () => {
      trendPaused = !trendPaused;
      trendDashboard.setPaused(trendPaused);
      document.querySelectorAll<HTMLButtonElement>("[data-trend-pause]").forEach(item => {
        item.textContent = trendPaused ? "再開" : "一時停止";
        item.classList.toggle("active", trendPaused);
      });
    };
  });
  document.querySelectorAll<HTMLButtonElement>("[data-trend-clear]").forEach(button => {
    button.onclick = () => trendDashboard.clear();
  });
  $<HTMLSelectElement>("comparison-metric").onchange = event => {
    trendDashboard.setComparisonMetric((event.currentTarget as HTMLSelectElement).value as any);
  };
  $<HTMLButtonElement>("jog-negative").onpointerdown = event => {
    event.preventDefault();
    startJog(-1);
  };
  $<HTMLButtonElement>("jog-positive").onpointerdown = event => {
    event.preventDefault();
    startJog(1);
  };
  document.addEventListener("pointerup", event => {
    stopJog();
    stopVerificationJogsForPointer(event.pointerId);
  });
  document.addEventListener("pointercancel", event => {
    stopJog();
    stopVerificationJogsForPointer(event.pointerId);
  });
  window.addEventListener("blur", () => {
    stopJog();
    stopAllVerificationJogs();
  });
  document.querySelectorAll<HTMLButtonElement>("[data-maintenance]").forEach(button => {
    button.onclick = () => void executeMaintenance({
      action: button.dataset.maintenance as BridgeMaintenanceRequest["action"]
    });
  });
  $("disconnect").onclick = async () => {
    if (!selectedBoardId) return;
    const boardId = selectedBoardId;
    await window.robotArmApi.disconnect(boardId);
    devices.delete(boardId);
    selectedBoardId = devices.keys().next().value as string | undefined;
    displayedSnapshot = selectedBoardId ? devices.get(selectedBoardId) : undefined;
    setMessage("切断しました。");
    renderDevices();
    renderSelectedDevice();
    renderMaintenance();
    renderMapping();
    renderConfigComparison();
    await refreshPorts();
  };

  try {
    mappingSettings = await window.robotArmApi.getMappingSettings();
  } catch (error) {
    setMappingMessage(`設定読込失敗: ${errorText(error)}`, true);
  }
  try {
    controlAppBoards = await window.robotArmApi.getControlAppBoards();
    knownControlAppBoardIds = new Set(controlAppBoards.map(board => board.boardId));
  } catch (error) {
    setMappingMessage(`制御アプリの基板一覧取得失敗: ${errorText(error)}`, true);
  }
  try {
    loggingState = await window.robotArmApi.getBridgeLoggingState();
  } catch (error) {
    setLoggingMessage(`ログ状態取得失敗: ${errorText(error)}`, true);
  }
  try {
    controlConnected = await window.robotArmApi.getControlConnectionState();
  } catch (error) {
    setControlMessage(`制御アプリ接続状態の取得失敗: ${errorText(error)}`, true);
  }
  try {
    robotSnapshot = await window.robotArmApi.getRobotArmSnapshot();
    trendDashboard.add(robotSnapshot);
  } catch (error) {
    $("dashboard-updated").textContent = `統合データ取得失敗: ${errorText(error)}`;
  }
  renderDevices();
  renderSelectedDevice();
  renderMaintenance();
  renderMapping();
  renderConfigComparison();
  renderLoggingState();
  renderControlPanel();
  renderThresholdPanel();
  renderDriverSettingsPanel();
  renderJointVerificationPanel(true);
  renderIntegratedDashboard();
  await refreshPorts();
  if (controlConnected) void autoLoadDriverSettings();
}

void init().catch(error => {
  setMessage(`画面初期化エラー: ${errorText(error)}`, true);
});

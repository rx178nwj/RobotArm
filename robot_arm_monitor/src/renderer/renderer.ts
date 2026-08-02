type AxisMappingEntry = import("../shared/types").AxisMappingEntry;
type BleDeviceInfo = import("../shared/types").BleDeviceInfo;
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
    scanBleDevices(): Promise<BleDeviceInfo[]>;
    connectBle(device: BleDeviceInfo): Promise<ConnectResult>;
    openBluetoothSettings(): Promise<void>;
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
    onDeviceUpdate(callback: (snapshot: DeviceSnapshot) => void): () => void;
    onBridgeLoggingUpdate(callback: (state: BridgeLoggingState) => void): () => void;
    onControlConnectionChanged(callback: (connected: boolean) => void): () => void;
    onControlEvent(callback: (event: ControlEvent) => void): () => void;
    onRobotArmUpdate(callback: (snapshot: RobotArmSnapshot) => void): () => void;
  };
}

const devices = new Map<string, DeviceSnapshot>();
let ports = new Map<string, PortInfo>();
let bleDevices = new Map<string, BleDeviceInfo>();
let bleScanBusy = false;
let selectedBoardId: string | undefined;
let displayedSnapshot: DeviceSnapshot | undefined;
let mappingSettings: MappingSettings = { axisMapping: [], boardLabels: {} };
let maintenanceBusy = false;
let configBusy = false;
let loggingState: BridgeLoggingState = { active: false, periodMs: 1000 };
let controlConnected = false;
let jogTimer: number | undefined;
let jogging = false;
let joggingAxis: number | undefined;
let deviceTabsSignature = "";
let robotSnapshot: RobotArmSnapshot = { axes: [], boards: [], controlAppConnected: false, timestamp: 0 };
let dashboardView: "summary" | "detail" | "comparison" | "boards" = "summary";
let trendDashboard: TrendCharts.RobotArmTrendDashboard;
let trendPaused = false;
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

function setBleMessage(text: string, error = false): void {
  const element = $("ble-message");
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
  controlConnected = connected;
  if (!connected) stopJog(false);
  renderControlPanel();
}

function onRobotArmUpdate(snapshot: RobotArmSnapshot): void {
  robotSnapshot = snapshot;
  trendDashboard.add(snapshot);
  const controlStateChanged = controlConnected !== snapshot.controlAppConnected;
  controlConnected = snapshot.controlAppConnected;
  if (controlStateChanged) renderControlPanel();
  renderIntegratedDashboard();
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
      return `<article class="board-raw-card"><h3>${esc(label)} <small>Motor · BLE</small></h3>
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
    $("ports").innerHTML = list.length ? list.map(port => `
      <article class="port ${port.candidate ? "candidate" : ""}">
        <div><strong>${esc(port.path)}</strong><small>${esc(port.manufacturer || "Serial device")}</small></div>
        <div class="port-actions">
          <span>${port.candidate ? "bridge候補 · VID 2e8a" : "その他"}</span>
          <button data-connect="${esc(port.path)}" ${activePaths.has(port.path) ? "disabled" : ""}>
            ${activePaths.has(port.path) ? "接続済み" : "接続"}
          </button>
        </div>
      </article>`).join("") : `<p class="empty">シリアルポートが見つかりません。</p>`;
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

async function scanBleDevices(): Promise<void> {
  if (bleScanBusy) return;
  bleScanBusy = true;
  $<HTMLButtonElement>("ble-scan").disabled = true;
  $("ble-devices").innerHTML = `<p class="empty">5秒間スキャンしています…</p>`;
  setBleMessage("SteppingMotorDriverのテレメトリService UUIDを検索しています…");
  try {
    const list = await window.robotArmApi.scanBleDevices();
    bleDevices = new Map(list.map(device => [device.path, device]));
    renderBleDevices();
    setBleMessage(
      list.length
        ? `${list.length}台のSteppingMotorDriver候補が見つかりました。`
        : "候補は見つかりませんでした。基板の電源とBluetoothを確認してください。"
    );
  } catch (error) {
    bleDevices.clear();
    renderBleDevices();
    setBleMessage(`BLEスキャン失敗: ${errorText(error)}`, true);
  } finally {
    bleScanBusy = false;
    $<HTMLButtonElement>("ble-scan").disabled = false;
  }
}

function renderBleDevices(): void {
  const activePaths = new Set([...devices.values()].map(device => device.path));
  const candidates = [...bleDevices.values()];
  $("ble-count").textContent = String(candidates.length);
  $("ble-devices").innerHTML = candidates.length ? candidates.map(device => `
    <article class="port candidate ble-device">
      <div>
        <strong>${esc(device.name)}</strong>
        <small>Board ID ${esc(device.boardId)} · RSSI ${device.rssi} dBm</small>
      </div>
      <div class="port-actions">
        <span>${esc(device.address ?? "Windows BLE ID")}</span>
        <button data-ble-connect="${esc(device.path)}" ${activePaths.has(device.path) ? "disabled" : ""}>
          ${activePaths.has(device.path) ? "接続済み" : "接続"}
        </button>
      </div>
    </article>`).join("") : `<p class="empty">「BLEをスキャン」で候補を検索してください。</p>`;
  document.querySelectorAll<HTMLButtonElement>("[data-ble-connect]").forEach(button => {
    button.onclick = () => void connectBle(button.dataset.bleConnect!);
  });
}

async function connectBle(path: string): Promise<void> {
  const info = bleDevices.get(path);
  if (!info) {
    setBleMessage("BLE候補を再スキャンしてください。", true);
    return;
  }
  setBleMessage(`${info.name}へ接続し、Device Infoを検証しています…`);
  try {
    const result = await window.robotArmApi.connectBle(info);
    selectedBoardId = result.boardId;
    displayedSnapshot = devices.get(result.boardId);
    setBleMessage(`${info.name} (${result.boardId}) に接続しました。`);
    renderDevices();
    renderSelectedDevice();
    renderBleDevices();
    renderMapping();
  } catch (error) {
    for (const [boardId, snapshot] of devices) {
      if (snapshot.path === path && (snapshot.state === "error" || snapshot.state === "timeout")) {
        devices.delete(boardId);
      }
    }
    setBleMessage(`BLE接続失敗: ${errorText(error)}`, true);
    renderDevices();
    renderBleDevices();
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
  if (deviceSetChanged) {
    renderMapping();
    renderBleDevices();
  }
  if (snapshot.kind === "multi_i2c_bridge") renderConfigComparison();
}

function renderDevices(): void {
  const connected = [...devices.values()].sort((a, b) => a.boardId.localeCompare(b.boardId));
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
      <small>${device.kind === "stepping_motor_driver" ? "Motor · BLE" : "Bridge · USB"} · ${esc(device.state)}</small>
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
  for (const device of devices.values()) if (device.kind === kind) boardIds.add(device.boardId);
  for (const mapping of mappingSettings.axisMapping) {
    const boardId = kind === "multi_i2c_bridge" ? mapping.bridgeBoardId : mapping.motorBoardId;
    if (boardId) boardIds.add(boardId);
  }
  if (selected) boardIds.add(selected);
  return [
    `<option value="">未割当</option>`,
    ...[...boardIds].sort().map(boardId => `
      <option value="${esc(boardId)}" ${selected === boardId ? "selected" : ""}>
        ${esc(mappingSettings.boardLabels[boardId] || boardId)}
      </option>`)
  ].join("");
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
  try {
    mappingSettings = await window.robotArmApi.saveMappingSettings({ axisMapping, boardLabels });
    robotSnapshot = await window.robotArmApi.getRobotArmSnapshot();
    setMappingMessage("軸マッピングを保存しました。");
    renderDevices();
    renderMapping();
    renderConfigComparison();
    renderControlPanel();
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
  window.robotArmApi.onDeviceUpdate(onDeviceUpdate);
  window.robotArmApi.onBridgeLoggingUpdate(onBridgeLoggingUpdate);
  window.robotArmApi.onControlConnectionChanged(onControlConnectionChanged);
  window.robotArmApi.onControlEvent(onControlEvent);
  window.robotArmApi.onRobotArmUpdate(onRobotArmUpdate);
  $("refresh").onclick = () => void refreshPorts();
  $("ble-scan").onclick = () => void scanBleDevices();
  $("ble-settings").onclick = () => void window.robotArmApi.openBluetoothSettings().catch(error => {
    setBleMessage(`Bluetooth設定を開けませんでした: ${errorText(error)}`, true);
  });
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
  $("dashboard-axis-select").onchange = () => renderAxisDetail();
  document.querySelectorAll<HTMLButtonElement>("[data-dashboard-view]").forEach(button => {
    button.onclick = () => switchDashboardView(button.dataset.dashboardView as typeof dashboardView);
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
  document.addEventListener("pointerup", () => stopJog());
  document.addEventListener("pointercancel", () => stopJog());
  window.addEventListener("blur", () => stopJog());
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
    renderBleDevices();
    await refreshPorts();
  };

  try {
    mappingSettings = await window.robotArmApi.getMappingSettings();
  } catch (error) {
    setMappingMessage(`設定読込失敗: ${errorText(error)}`, true);
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
  renderBleDevices();
  renderControlPanel();
  renderIntegratedDashboard();
  await refreshPorts();
}

void init().catch(error => {
  setMessage(`画面初期化エラー: ${errorText(error)}`, true);
});

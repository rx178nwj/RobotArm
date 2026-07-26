type AxisMappingEntry = import("../shared/types").AxisMappingEntry;
type BridgeMaintenanceRequest = import("../shared/types").BridgeMaintenanceRequest;
type BridgeMaintenanceResult = import("../shared/types").BridgeMaintenanceResult;
type BridgeSnapshot = import("../shared/types").BridgeSnapshot;
type ConnectResult = import("../shared/types").ConnectResult;
type DeviceSnapshot = import("../shared/types").DeviceSnapshot;
type MappingSettings = import("../shared/types").MappingSettings;
type PortInfo = import("../shared/types").PortInfo;

interface Window {
  robotArmApi: {
    listPorts(): Promise<PortInfo[]>;
    connect(port: PortInfo): Promise<ConnectResult>;
    disconnect(boardId: string): Promise<void>;
    executeBridgeMaintenance(
      boardId: string,
      request: BridgeMaintenanceRequest
    ): Promise<BridgeMaintenanceResult>;
    getMappingSettings(): Promise<MappingSettings>;
    saveMappingSettings(settings: MappingSettings): Promise<MappingSettings>;
    onDeviceUpdate(callback: (snapshot: DeviceSnapshot) => void): () => void;
  };
}

const devices = new Map<string, DeviceSnapshot>();
let ports = new Map<string, PortInfo>();
let selectedBoardId: string | undefined;
let displayedSnapshot: DeviceSnapshot | undefined;
let mappingSettings: MappingSettings = { axisMapping: [], boardLabels: {} };
let maintenanceBusy = false;

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
  displayedSnapshot = snapshot;
  if (snapshot.boardId !== "unidentified") {
    if (snapshot.state === "disconnected") {
      devices.delete(snapshot.boardId);
      if (selectedBoardId === snapshot.boardId) {
        selectedBoardId = devices.keys().next().value as string | undefined;
        displayedSnapshot = selectedBoardId ? devices.get(selectedBoardId) : snapshot;
      }
    } else {
      devices.set(snapshot.boardId, snapshot);
      if (!selectedBoardId) selectedBoardId = snapshot.boardId;
      if (selectedBoardId === snapshot.boardId) displayedSnapshot = snapshot;
    }
  }
  renderDevices();
  renderSelectedDevice();
  renderMapping();
}

function renderDevices(): void {
  const connected = [...devices.values()];
  $("devices").innerHTML = connected.length ? connected.map(device => `
    <button class="device-button ${selectedBoardId === device.boardId ? "selected" : ""}" data-device="${esc(device.boardId)}">
      <strong>${esc(mappingSettings.boardLabels[device.boardId] || device.boardId)}</strong>
      <small>${esc(device.path)} · ${esc(device.state)}</small>
    </button>`).join("") : `<p class="empty">接続中の基板はありません。</p>`;
  document.querySelectorAll<HTMLButtonElement>("[data-device]").forEach(button => {
    button.onclick = () => {
      selectedBoardId = button.dataset.device;
      displayedSnapshot = selectedBoardId ? devices.get(selectedBoardId) : undefined;
      renderDevices();
      renderSelectedDevice();
      renderMaintenance();
    };
  });
}

function renderSelectedDevice(): void {
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
  const metrics = snapshot.metrics.slice(0, 2);
  $("status").innerHTML = `
    <div><span>Port</span><strong>${esc(snapshot.path)}</strong></div>
    <div><span>Protocol</span><strong>${esc(snapshot.protocolVersion ?? "—")}</strong></div>
    <div><span>${esc(metrics[0]?.label ?? "Status")}</span><strong>${esc(metrics[0]?.value ?? "—")}</strong></div>
    <div><span>${esc(metrics[1]?.label ?? "Last update")}</span><strong>${esc(metrics[1]?.value ?? "—")}</strong></div>`;
  $<HTMLButtonElement>("disconnect").disabled = !devices.has(snapshot.boardId);
  $("log").innerHTML = snapshot.rawLog.length ? snapshot.rawLog.map(entry => `
    <div class="log-line ${entry.direction}">
      <time>${new Date(entry.timestamp).toLocaleTimeString("ja-JP", { hour12: false, fractionalSecondDigits: 3 })}</time>
      <b>${entry.direction.toUpperCase()}</b>
      <code>${esc(entry.text)}</code>
    </div>`).join("") : `<p class="empty">ログはまだありません。</p>`;
  $("log").scrollTop = $("log").scrollHeight;
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
    return {
      axisId,
      label: labelElement.value.trim() || `Axis ${axisId}`,
      ...(motorBoardId ? {
        motorBoardId,
        ...(motorAxis === "" ? {} : { motorLocalAxis: Number(motorAxis) })
      } : {}),
      ...(bridgeBoardId ? {
        bridgeBoardId,
        ...(bridgeChannel === "" ? {} : { bridgeLocalChannel: Number(bridgeChannel) })
      } : {})
    };
  });
  const boardLabels: Record<string, string> = {};
  document.querySelectorAll<HTMLInputElement>("[data-board-label]").forEach(input => {
    boardLabels[input.dataset.boardLabel!] = input.value.trim();
  });
  try {
    mappingSettings = await window.robotArmApi.saveMappingSettings({ axisMapping, boardLabels });
    setMappingMessage("軸マッピングを保存しました。");
    renderDevices();
    renderMapping();
  } catch (error) {
    setMappingMessage(`保存失敗: ${errorText(error)}`, true);
  }
}

async function init(): Promise<void> {
  window.robotArmApi.onDeviceUpdate(onDeviceUpdate);
  $("refresh").onclick = () => void refreshPorts();
  $("manual-connect").onclick = () => void connect($<HTMLInputElement>("manual-port").value.trim());
  $("save-mapping").onclick = () => void saveMapping();
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
    await refreshPorts();
  };

  try {
    mappingSettings = await window.robotArmApi.getMappingSettings();
  } catch (error) {
    setMappingMessage(`設定読込失敗: ${errorText(error)}`, true);
  }
  renderDevices();
  renderSelectedDevice();
  renderMaintenance();
  renderMapping();
  await refreshPorts();
}

void init().catch(error => {
  setMessage(`画面初期化エラー: ${errorText(error)}`, true);
});

type AppSettings = import("../shared/types").AppSettings;
type ChannelData = import("../shared/types").ChannelData;
type DeviceSnapshot = import("../shared/types").DeviceSnapshot;
type PortInfo = import("../shared/types").PortInfo;

const devices = new Map<string, DeviceSnapshot>();
const ports = new Map<string, PortInfo>();
const angleHistory = new Map<string, Array<{ time: number; values: Array<number | null> }>>();
let selected: string | null = null;
let settings: AppSettings = { periodMs: 1000, historySeconds: 60, layout: "single", labels: {} };
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!));
const stateClass = (state: string) => state === "monitoring" ? "ok" : state === "connecting" ? "warn" : state === "error" || state === "timeout" ? "bad" : "";
const labelFor = (d: DeviceSnapshot) => settings.labels[d.serialNumber] || `Bridge ${d.serialNumber.slice(-6) || d.path}`;

function showConnectionMessage(message: string, kind: "info" | "error" | "success" = "info") {
  const element = $("connection-message");
  element.textContent = message;
  element.className = `connection-message ${kind}`;
}

async function refreshPorts() {
  try {
    const list = await window.bridgeApi.listPorts();
    ports.clear();
    list.forEach(p => ports.set(p.path, p));
    $("ports").innerHTML = list.length ? list.map(p => `<div class="port"><div class="port-top"><b>${esc(p.path)}</b><button data-connect="${esc(p.path)}">Connect</button></div><small>${p.candidate ? "RP2040 candidate" : "Serial device"} · ${esc(p.serialNumber || p.manufacturer || "unknown")}</small></div>`).join("") : `<div class="empty-small">No serial ports</div>`;
    document.querySelectorAll<HTMLButtonElement>("[data-connect]").forEach(button => {
      button.onclick = () => void connect(button.dataset.connect!, button);
    });
  } catch (error) {
    $("ports").innerHTML = `<div class="empty-small">Port scan failed. Retrying…</div>`;
    showConnectionMessage(`Port scan failed: ${String(error)}`, "error");
    console.error("Port scan failed", error);
  }
}

async function connect(path: string, sourceButton?: HTMLButtonElement) {
  if (!path) {
    showConnectionMessage("Enter a serial port such as COM34.", "error");
    return;
  }
  const info = ports.get(path) || { path, candidate: false };
  const originalText = sourceButton?.textContent || "Connect";
  if (sourceButton) {
    sourceButton.disabled = true;
    sourceButton.textContent = "Connecting…";
  }
  showConnectionMessage(`Connecting to ${path}…`);
  try {
    const id = await window.bridgeApi.connect(info, settings.periodMs);
    selected = id;
    showConnectionMessage(`Connected to ${path}.`, "success");
    render();
  } catch (error) {
    showConnectionMessage(`Could not open ${path}: ${String(error)}`, "error");
    console.error(`Could not open ${path}`, error);
  } finally {
    if (sourceButton) {
      sourceButton.disabled = false;
      sourceButton.textContent = originalText;
    }
  }
}

function channelState(c: ChannelData): [string,string] {
  if (!c.present) return ["UNAVAILABLE", ""];
  if (!c.enable) return ["DISABLED", "warn"];
  if (!c.ok) return ["FAULT", "bad"];
  return ["OK", "ok"];
}

function updateHistory(d: DeviceSnapshot) {
  if (!d.channels.length) return;
  const h = angleHistory.get(d.id) || [];
  h.push({ time: Date.now(), values: Array.from({length:6}, (_,ch) => d.channels.find(c => c.channel === ch)?.degrees ?? null) });
  const cutoff = Date.now() - settings.historySeconds * 1000;
  while (h[0]?.time < cutoff) h.shift();
  angleHistory.set(d.id, h);
}

function gauges(d: DeviceSnapshot) {
  return Array.from({length:6}, (_,ch) => {
    const c = d.channels.find(x => x.channel === ch); const valid = c?.degrees != null; const state = c ? channelState(c)[0] : "WAIT";
    return `<div class="gauge ${valid ? "" : "invalid"}"><div class="dial" style="--angle:${valid ? c!.degrees : 0}deg"></div><strong>${valid ? c!.degrees!.toFixed(3)+"°" : state}</strong><small>CH${ch} · AGC ${c?.agc ?? "—"}</small></div>`;
  }).join("");
}

function tableRows(d: DeviceSnapshot) {
  return d.channels.map(c => { const [state,cls] = channelState(c); return `<tr class="${cls === "bad" ? "row-fault" : cls === "warn" ? "row-disabled" : ""}"><td>CH${c.channel} · ${state}</td><td>${+c.present}</td><td>${+c.enable}</td><td>${+c.ok}</td><td>${c.degrees?.toFixed(3) ?? "invalid"}</td><td>${c.zeroOffset}</td><td>${c.agc}</td><td>0x${c.magnetRaw.toString(16).padStart(2,"0")}</td><td>${c.readOk}</td><td>${c.readErr}</td></tr>`; }).join("");
}

function detail(d: DeviceSnapshot, mini=false) {
  const s=d.status; const master=d.master; const anyFault=d.channels.some(c=>c.present&&c.enable&&!c.ok); const disabled=d.channels.some(c=>c.present&&!c.enable);
  return `<article class="dashboard card-shell"><div class="status-row"><span class="chip ${stateClass(d.state)}"><i class="dot"></i>USB: ${d.state}</span><span class="chip ${master?.active ? "ok":"warn"}"><i class="dot"></i>MASTER: ${master?.active ? "active":"idle"}</span><span class="chip ${anyFault ? "bad":disabled ? "warn":"ok"}"><i class="dot"></i>SENSORS: ${anyFault ? "fault":disabled ? "mixed":"ok"}</span><span class="chip">${esc(d.path)} · ${esc(d.serialNumber)}</span></div>
  <section class="card"><h3>${esc(labelFor(d))} · ANGLES</h3><div class="gauges">${gauges(d)}</div></section>
  <section class="card chart-wrap"><h3>ANGLE HISTORY · ${settings.historySeconds}s</h3><canvas data-chart="${esc(d.id)}"></canvas></section>
  ${mini ? "" : `<div class="two-col"><section class="card"><h3>CHANNEL STATUS</h3><table><thead><tr><th>Channel</th><th>Present</th><th>Enable</th><th>OK</th><th>Degree</th><th>Zero off</th><th>AGC</th><th>Mag</th><th>Read OK</th><th>Read Err</th></tr></thead><tbody>${tableRows(d)}</tbody></table></section><section class="card"><h3>UPSTREAM I2C</h3><div class="master-grid"><div class="metric"><span>WRITE TX</span><b>${master?.writeTx ?? 0}</b></div><div class="metric"><span>READ REQUESTS</span><b>${master?.readReq ?? 0}</b></div><div class="metric"><span>WRITE BYTES</span><b>${master?.writeBytes ?? 0}</b></div><div class="metric"><span>READ BYTES</span><b>${master?.readBytes ?? 0}</b></div></div><p>Last activity: ${master?.lastActivityMs ?? "unknown"} ms</p><p>FAULT: 0x${(s?.fault??0).toString(16).padStart(2,"0")} ${esc(s?.faultNames)}</p><p>CH_FAULT: 0x${(s?.chFault??0).toString(16).padStart(2,"0")} ${esc(s?.chFaultNames)}</p><div class="raw">${esc(d.rawLines.slice(-8).join("\n"))}</div></section></div>`}</article>`;
}

function drawCharts() {
  document.querySelectorAll<HTMLCanvasElement>("canvas[data-chart]").forEach(canvas => {
    const rect=canvas.getBoundingClientRect(), ratio=devicePixelRatio; canvas.width=rect.width*ratio; canvas.height=rect.height*ratio; const ctx=canvas.getContext("2d")!; ctx.scale(ratio,ratio);
    const w=rect.width,h=rect.height,p=28; ctx.clearRect(0,0,w,h); ctx.strokeStyle="#20324a";ctx.lineWidth=1;ctx.font="10px Segoe UI";ctx.fillStyle="#71839a";
    for(let y=0;y<=4;y++){const py=p+(h-p*2)*y/4;ctx.beginPath();ctx.moveTo(p,py);ctx.lineTo(w-p,py);ctx.stroke();ctx.fillText(String(360-y*90),3,py+3)}
    const data=angleHistory.get(canvas.dataset.chart!)||[], start=Date.now()-settings.historySeconds*1000, colors=["#3ad6db","#ff9f68","#ad8cff","#40d890","#f4bf50","#ff657a"];
    for(let ch=0;ch<6;ch++){ctx.strokeStyle=colors[ch];ctx.lineWidth=1.8;ctx.beginPath();let begun=false;for(const point of data){const v=point.values[ch];if(v==null){begun=false;continue}const x=p+(w-p*2)*(point.time-start)/(settings.historySeconds*1000),y=p+(h-p*2)*(1-v/360);if(!begun){ctx.moveTo(x,y);begun=true}else ctx.lineTo(x,y)}ctx.stroke()}
  });
}

function render() {
  $("devices").innerHTML = devices.size ? [...devices.values()].map(d=>`<div class="device-item ${selected===d.id?"selected":""}" data-device="${esc(d.id)}"><div class="device-top"><b>${esc(labelFor(d))}</b><span class="${stateClass(d.state)}"><i class="dot"></i></span></div><small>${esc(d.path)} · ${d.state}</small></div>`).join("") : `<div class="empty-small">No active devices</div>`;
  document.querySelectorAll<HTMLElement>("[data-device]").forEach(el=>el.onclick=()=>{selected=el.dataset.device!;render()});
  const list=[...devices.values()]; $("subtitle").textContent = `${list.length} bridge${list.length===1?"":"s"} connected · ${settings.periodMs} ms update`;
  if(settings.layout==="grid"&&list.length){$("content").className="grid-mode";$("content").innerHTML=list.map(d=>detail(d,true)).join("")}else{$("content").className="";const d=selected?devices.get(selected):undefined;$("content").innerHTML=d?detail(d):`<div class="welcome"><h2>Waiting for a bridge</h2></div>`} requestAnimationFrame(drawCharts);
}

async function init() {
  window.bridgeApi.onDeviceUpdate(d => {
    devices.set(d.id, d);
    if (!selected) selected = d.id;
    updateHistory(d);
    render();
  });

  $("refresh").onclick = () => void refreshPorts();
  $("manual-connect").onclick = event => void connect($<HTMLInputElement>("manual-port").value.trim(), event.currentTarget as HTMLButtonElement);
  $("start-all").onclick = () => void window.bridgeApi.setAllMonitors(true, settings.periodMs);
  $("stop-all").onclick = () => void window.bridgeApi.setAllMonitors(false, settings.periodMs);
  $("period").onchange = () => {
    settings.periodMs = Math.max(100, Math.min(60000, Number($<HTMLInputElement>("period").value)));
    void window.bridgeApi.saveSettings(settings);
  };
  $("layout").onclick = () => {
    settings.layout = settings.layout === "single" ? "grid" : "single";
    void window.bridgeApi.saveSettings(settings);
    render();
  };

  try {
    settings = await window.bridgeApi.getSettings();
    $<HTMLInputElement>("period").value = String(settings.periodMs);
  } catch (error) {
    showConnectionMessage(`Settings could not be loaded: ${String(error)}`, "error");
    console.error("Settings load failed", error);
  }

  render();
  await refreshPorts();
  setInterval(() => void refreshPorts(), 3000);
}

void init().catch(error => {
  showConnectionMessage(`UI initialization failed: ${String(error)}`, "error");
  console.error("UI initialization failed", error);
});

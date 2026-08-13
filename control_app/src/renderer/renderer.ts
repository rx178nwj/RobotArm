type AppSnapshot = import("../shared/types").AppSnapshot;

interface ControlAppApi {
  getSnapshot(): Promise<AppSnapshot>;
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void;
}

const api = (window as unknown as { controlAppApi: ControlAppApi }).controlAppApi;
const ipcStatus = document.querySelector<HTMLElement>("#ipc-status")!;
const boardCount = document.querySelector<HTMLElement>("#board-count")!;
const boards = document.querySelector<HTMLElement>("#boards")!;
const logs = document.querySelector<HTMLElement>("#logs")!;

function render(snapshot: AppSnapshot): void {
  document.title = `Robot Arm Control (${snapshot.boards.length} board${snapshot.boards.length === 1 ? "" : "s"})`;
  ipcStatus.className = `status ${snapshot.ipcClientConnected ? "connected" : "disconnected"}`;
  ipcStatus.innerHTML = `<span></span> IPC ${snapshot.ipcClientConnected ? "接続中" : "未接続"}`;
  boardCount.textContent = `${snapshot.boards.length} board${snapshot.boards.length === 1 ? "" : "s"}`;
  boards.replaceChildren();
  if (snapshot.boards.length === 0) {
    boards.innerHTML = '<p class="empty">接続中の基板はありません</p>';
  } else {
    for (const board of snapshot.boards) {
      const card = document.createElement("article");
      card.className = "board-card";
      const id = document.createElement("strong");
      id.textContent = board.boardId;
      const path = document.createElement("span");
      path.textContent = board.path;
      const state = document.createElement("em");
      state.textContent = board.state;
      card.append(id, path, state);
      boards.append(card);
    }
  }
  logs.replaceChildren();
  if (snapshot.logs.length === 0) {
    logs.innerHTML = '<p class="empty">ログはありません</p>';
  } else {
    for (const entry of [...snapshot.logs].reverse()) {
      const row = document.createElement("div");
      row.className = "log-row";
      const time = document.createElement("time");
      time.textContent = new Date(entry.timestamp).toLocaleTimeString("ja-JP", { hour12: false });
      const source = document.createElement("b");
      source.textContent = entry.source.toUpperCase();
      const message = document.createElement("span");
      message.textContent = entry.message;
      row.append(time, source, message);
      logs.append(row);
    }
  }
}

async function refreshSnapshot(): Promise<void> {
  try {
    render(await api.getSnapshot());
  } catch (error) {
    console.error("Failed to refresh control app snapshot", error);
  }
}

void refreshSnapshot();
api.onSnapshot(render);
window.setInterval(() => void refreshSnapshot(), 1000);

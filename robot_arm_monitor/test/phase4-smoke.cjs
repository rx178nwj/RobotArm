const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CsvLogger, csvRow } = require("../dist/main/csv-logger.js");
const { MultiI2cBridgeAdapter } = require("../dist/main/adapters/multi-i2c-bridge-adapter.js");
const { parseConfig } = require("../dist/main/adapters/parser.js");

const configLine = "CONFIG angle_src=RAW poll_period_ms=0 status_decim=9 as5600_conf=0x0A00 ch_enable=0x3F dir_config=0x02 dir_applied=0x02";
assert.deepEqual(parseConfig(configLine), {
  angleSrc: "RAW",
  pollPeriodMs: 0,
  statusDecim: 9,
  as5600Conf: 0x0A00,
  chEnable: 0x3F,
  dirConfig: 0x02,
  dirApplied: 0x02
});
assert.equal(parseConfig("STATUS samples=1"), null);
assert.equal(csvRow(["plain", "a,b", "a\"b", "a\nb"]), "plain,\"a,b\",\"a\"\"b\",\"a\nb\"");

async function verifyAdapterAndCsv() {
  const batchAdapter = new MultiI2cBridgeAdapter("BATCH000000000001", "1");
  batchAdapter.sendCommand = () => {};
  let batchUpdates = 0;
  batchAdapter.on("update", () => { batchUpdates += 1; });
  batchAdapter.startMonitor(100);
  batchAdapter.onLine("STATUS status_lo=0x01 status_hi=0x02 fault=0x00 ch_fault=0x00 present=0x01 enable=0x01 samples=1 cmd=0x00 uptime_ms=10");
  batchAdapter.onLine("DOWNSTREAM bus_recoveries=0 mux_resets=0 rescans=0");
  batchAdapter.onLine("FAULTS none");
  batchAdapter.onLine("CH_FAULTS none");
  batchAdapter.onLine("CH PRESENT ENABLE OK DIR_CFG DIR_OUT ANGLE DEGREE AGC MAG_RAW MD ML MH READ_OK READ_ERR LAST_OK_MS LAST_ERR_MS");
  for (let channel = 0; channel < 5; channel += 1) {
    batchAdapter.onLine(`${channel} 1 1 1 0 0 ${100 + channel} ${10 + channel}.5 20 300 1 0 0 ${50 + channel} 0 9 0`);
  }
  assert.equal(batchUpdates, 0, "partial monitor frames must not publish UI snapshots");
  batchAdapter.onLine("5 0 0 0 0 0 invalid invalid 255 0 0 0 0 0 0 0 0");
  assert.equal(batchUpdates, 1, "a complete monitor frame publishes exactly one UI snapshot");
  batchAdapter.stopTimers();

  const adapter = new MultiI2cBridgeAdapter("3E3FD41AF8EF45FB", "1");
  const commands = [];
  adapter.sendCommand = command => commands.push(command);

  const configPromise = adapter.requestConfig();
  adapter.onLine(configLine);
  assert.deepEqual(await configPromise, parseConfig(configLine));
  assert.deepEqual(adapter.getSnapshot().config, parseConfig(configLine));

  const snapshotPromise = new Promise(resolve => adapter.once("logSnapshot", resolve));
  adapter.startLogging(1000);
  adapter.onLine("STATUS status_lo=0x00 status_hi=0x00 fault=0x02 ch_fault=0x04 present=0x3F enable=0x3F samples=1 cmd=0x00 uptime_ms=10");
  for (let channel = 0; channel < 6; channel += 1) {
    adapter.onLine(`${channel} 1 1 1 0 0 ${100 + channel} ${10 + channel}.5 20 300 1 0 0 ${50 + channel} ${channel} 9 0`);
  }
  assert.ok(commands.includes("monitor 1000"));
  assert.equal(commands.at(-1), "master");
  adapter.onLine("MASTER write_tx=1 write_bytes=2 read_req=3 read_bytes=4 last_activity_ms=99 log_seq=5");
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.channels.length, 6);
  assert.equal(snapshot.master.lastActivityMs, 99);
  assert.equal(snapshot.status.fault, 2);

  adapter.port = { isOpen: true };
  adapter.stopLogging();
  assert.equal(commands.at(-1), "monitor 100", "live monitoring resumes after CSV logging stops");
  adapter.stopTimers();

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "robot-arm-monitor-phase4-"));
  const csvPath = path.join(tempDir, "bridge.csv");
  try {
    fs.writeFileSync(csvPath, "header\r\n", "utf8");
    const logger = new CsvLogger();
    logger.state = { active: true, periodMs: 1000, filePath: csvPath, startedAt: Date.now() };
    await logger.appendBridgeSnapshot(snapshot);
    await logger.stopBridgeLog();
    const lines = fs.readFileSync(csvPath, "utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 7);
    assert.match(lines[1], /3E3FD41AF8EF45FB,0,1,1,1,100,10\.5,20,50,0,2,4,99$/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

verifyAdapterAndCsv()
  .then(() => console.log("PHASE4_CONFIG_CSV_SMOKE_OK"))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });

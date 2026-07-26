const assert = require("node:assert/strict");
const { bridgeMaintenanceCommand } = require("../dist/main/device-manager.js");
const { MultiI2cBridgeAdapter } = require("../dist/main/adapters/multi-i2c-bridge-adapter.js");

assert.equal(bridgeMaintenanceCommand({ action: "fault_clear" }), "fault clear");
assert.equal(bridgeMaintenanceCommand({ action: "rescan" }), "rescan");
assert.equal(bridgeMaintenanceCommand({ action: "mux_reset" }), "mux reset");
assert.equal(bridgeMaintenanceCommand({ action: "reboot" }), "reboot");
assert.equal(
  bridgeMaintenanceCommand({ action: "channel_enable", channel: 0 }),
  "ch 0 enable"
);
assert.equal(
  bridgeMaintenanceCommand({ action: "channel_disable", channel: 5 }),
  "ch 5 disable"
);
assert.equal(
  bridgeMaintenanceCommand({ action: "channel_direction", channel: 3, direction: 1 }),
  "ch 3 dir 1"
);
assert.throws(
  () => bridgeMaintenanceCommand({ action: "channel_enable", channel: 6 }),
  /0 to 5/
);
assert.throws(
  () => bridgeMaintenanceCommand({ action: "channel_direction", channel: 1, direction: 2 }),
  /0 or 1/
);
assert.throws(
  () => bridgeMaintenanceCommand({ action: "arbitrary_command" }),
  /Unsupported/
);

async function verifyResponses() {
  const adapter = new MultiI2cBridgeAdapter("3E3FD41AF8EF45FB", "1");
  adapter.sendCommand = function sendSuccessfulCommand() {
    queueMicrotask(() => this.onLine("OK faults cleared"));
  };
  assert.equal(await adapter.executeCommand("fault clear"), "OK faults cleared");

  adapter.sendCommand = function sendRejectedCommand() {
    queueMicrotask(() => this.onLine("ERR bridge command busy"));
  };
  await assert.rejects(adapter.executeCommand("rescan"), /bridge command busy/);

  let statusPolls = 0;
  adapter.sendCommand = function sendQueuedCommand(command) {
    if (command === "rescan") {
      queueMicrotask(() => this.onLine("OK command queued"));
      return;
    }
    statusPolls += 1;
    const commandState = statusPolls === 1 ? "0x01" : "0x00";
    queueMicrotask(() => this.onLine(
      `STATUS status_lo=0x00 status_hi=0x00 fault=0x00 ch_fault=0x00 present=0x00 enable=0x01 samples=1 cmd=${commandState} uptime_ms=1`
    ));
  };
  assert.equal(
    await adapter.executeCommand("rescan"),
    "OK command queued; completed cmd=0x00"
  );
  assert.ok(statusPolls >= 2);

  adapter.sendCommand = function sendFailedQueuedCommand(command) {
    queueMicrotask(() => this.onLine(command === "mux reset"
      ? "OK command queued"
      : "STATUS status_lo=0x00 status_hi=0x00 fault=0x00 ch_fault=0x00 present=0x00 enable=0x01 samples=1 cmd=0xFF uptime_ms=1"
    ));
  };
  await assert.rejects(adapter.executeCommand("mux reset"), /cmd=0xff/);
}

verifyResponses()
  .then(() => console.log("PHASE3_MAINTENANCE_SMOKE_OK"))
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });

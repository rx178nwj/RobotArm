const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const testDataPath = path.join(os.tmpdir(), `robot-arm-monitor-phase2-${process.pid}`);
app.setPath("userData", testDataPath);

app.whenReady().then(() => {
  const { AxisMappingStore, validateMappingSettings } = require("../dist/main/axis-mapping.js");
  try {
    const store = new AxisMappingStore();
    const expected = {
      axisMapping: [
        {
          axisId: 1,
          label: "J1",
          bridgeBoardId: "3E3FD41AF8EF45FB",
          bridgeLocalChannel: 0
        },
        {
          axisId: 2,
          label: "J2",
          bridgeBoardId: "3E3FD41AF8EF45FB",
          bridgeLocalChannel: 1
        }
      ],
      boardLabels: { "3E3FD41AF8EF45FB": "Bridge 1" }
    };
    assert.deepEqual(store.set(expected), expected);
    assert.deepEqual(new AxisMappingStore().get(), expected);
    assert.throws(() => validateMappingSettings({
      axisMapping: [
        expected.axisMapping[0],
        { ...expected.axisMapping[0], axisId: 2 }
      ],
      boardLabels: {}
    }), /duplicated/);
    assert.throws(() => validateMappingSettings({
      axisMapping: Array.from({ length: 13 }, (_, index) => ({
        axisId: index + 1,
        label: `Axis ${index + 1}`
      })),
      boardLabels: {}
    }), /maximum of 12/);
    console.log("PHASE2_SETTINGS_SMOKE_OK");
  } finally {
    fs.rmSync(testDataPath, { recursive: true, force: true });
    app.quit();
  }
}).catch(error => {
  console.error(error);
  app.exit(1);
});

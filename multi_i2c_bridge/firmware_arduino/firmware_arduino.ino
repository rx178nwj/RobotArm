#include <Arduino.h>
#include <EEPROM.h>
#include <Wire.h>

#include <atomic>
#include <ctype.h>
#include <stdlib.h>
#include <string.h>

#include "hardware/gpio.h"
#include "hardware/regs/i2c.h"
#include "hardware/structs/i2c.h"
#include "hardware/watchdog.h"

#ifndef MULTI_I2C_BRIDGE_USB_CONSOLE
#define MULTI_I2C_BRIDGE_USB_CONSOLE 1
#endif

namespace {

constexpr uint8_t kChannelCount = 6;
constexpr uint8_t kBridgeAddr = 0x42;
constexpr uint8_t kMuxAddr = 0x70;
constexpr uint8_t kAs5600Addr = 0x36;

constexpr uint8_t kUpSda = 0;
constexpr uint8_t kUpScl = 1;
constexpr uint8_t kDsSda = 2;
constexpr uint8_t kDsScl = 3;
constexpr uint8_t kMuxReset = 4;
constexpr uint8_t kDir0 = 5;
constexpr uint8_t kDir1 = 6;
constexpr uint8_t kDir2 = 7;
constexpr uint8_t kDir3 = 8;
constexpr uint8_t kDir4 = 9;
constexpr uint8_t kDir5 = 10;
constexpr uint8_t kBlueLed = 25;
constexpr uint8_t kYellowLed = 27;
constexpr uint8_t kRedLed = 28;

constexpr uint32_t kI2cBaud = 400000;
constexpr uint8_t kWhoAmI = 0xB6;
constexpr uint8_t kVersion = 0x10;  // major=1(6ch)/minor=0, command_spec.md §9.1
constexpr uint16_t kAs5600ConfDefault = 0x0A00;
constexpr uint8_t kChMask = 0x3Fu;  // bit0-5 = ch0-5

constexpr uint32_t kWdtTimeoutMs = 500;
constexpr uint8_t kStatusDecimDefault = 9;
constexpr uint8_t kPollPeriodDefault = 0;
constexpr uint32_t kAs5600PowerUpMs = 10;
constexpr uint32_t kStatusLedPeriodMs = 200;
constexpr uint8_t kDsFailRecoverN = 3;
constexpr uint8_t kDsMuxResetN = 2;
constexpr size_t kConsoleLineSize = 128;
constexpr size_t kUpstreamLogDepth = 64;
constexpr size_t kDiagPayloadMax = 8;
constexpr uint32_t kIdentityMagic = 0x31444942u;  // "BID1"
constexpr size_t kIdentityLength = 16;

struct StoredIdentity {
  uint32_t magic;
  char id[kIdentityLength + 1];
  uint8_t checksum;
};

char gBridgeIdentity[kIdentityLength + 1]{};

uint8_t identityChecksum(const char *id) {
  uint8_t checksum = 0xA5u;
  for (size_t i = 0; i < kIdentityLength; ++i) {
    checksum = static_cast<uint8_t>((checksum << 1u) | (checksum >> 7u));
    checksum ^= static_cast<uint8_t>(id[i]);
  }
  return checksum;
}

bool validIdentity(const char *id) {
  if (id == nullptr || strlen(id) != kIdentityLength) {
    return false;
  }
  for (size_t i = 0; i < kIdentityLength; ++i) {
    if (!isxdigit(static_cast<unsigned char>(id[i]))) {
      return false;
    }
  }
  return true;
}

void copyIdentity(char *destination, const char *source) {
  for (size_t i = 0; i < kIdentityLength; ++i) {
    destination[i] = static_cast<char>(toupper(static_cast<unsigned char>(source[i])));
  }
  destination[kIdentityLength] = '\0';
}

void loadBridgeIdentity() {
  EEPROM.begin(sizeof(StoredIdentity));
  StoredIdentity stored{};
  EEPROM.get(0, stored);
  if (stored.magic == kIdentityMagic && validIdentity(stored.id) &&
      stored.checksum == identityChecksum(stored.id)) {
    copyIdentity(gBridgeIdentity, stored.id);
  } else {
    copyIdentity(gBridgeIdentity, rp2040.getChipID());
  }
}

bool saveBridgeIdentity(const char *id) {
  if (!validIdentity(id)) {
    return false;
  }
  StoredIdentity stored{};
  stored.magic = kIdentityMagic;
  copyIdentity(stored.id, id);
  stored.checksum = identityChecksum(stored.id);
  EEPROM.put(0, stored);
  if (!EEPROM.commit()) {
    return false;
  }
  copyIdentity(gBridgeIdentity, stored.id);
  return true;
}

// レジスタマップ確定仕様: command_spec.md §3 (6ch/v1.0)
constexpr uint8_t REG_WHO_AM_I = 0x00;
constexpr uint8_t REG_VERSION = 0x01;
constexpr uint8_t REG_STATUS_LO = 0x02;
constexpr uint8_t REG_STATUS_HI = 0x03;
constexpr uint8_t REG_FAULT = 0x04;
constexpr uint8_t REG_CH_FAULT = 0x05;
constexpr uint8_t REG_SAMPLE_COUNT = 0x08;  // 4 bytes LE, 0x08-0x0B
constexpr uint8_t REG_CH0_ANGLE = 0x10;     // 12 bytes, 0x10-0x1B
constexpr uint8_t REG_STATUS_LO_M = 0x1C;
constexpr uint8_t REG_STATUS_HI_M = 0x1D;
constexpr uint8_t REG_SAMPLE_LO = 0x1E;
constexpr uint8_t REG_CH0_AGC = 0x30;  // 6 bytes, 0x30-0x35
constexpr uint8_t REG_CONFIG = 0x40;
constexpr uint8_t REG_POLL_PERIOD = 0x41;
constexpr uint8_t REG_DIR_CONFIG = 0x42;
constexpr uint8_t REG_STATUS_DECIM = 0x43;
constexpr uint8_t REG_AS5600_CONF_LO = 0x44;  // 2 bytes, 0x44-0x45
constexpr uint8_t REG_CH_PRESENT = 0x46;
constexpr uint8_t REG_CH_ENABLE = 0x47;
constexpr uint8_t REG_CMD = 0x50;
constexpr uint8_t REG_COUNT = 0x51;  // txStaging size (indices 0x00..0x50)

// STATUS_HI (0x03) ビット定義, command_spec.md §4.1
constexpr uint8_t STATUS_HI_DEGRADED = 1u << 0;
constexpr uint8_t STATUS_HI_DATA_NEW = 1u << 1;
constexpr uint8_t STATUS_HI_MUX_FAULT = 1u << 2;
constexpr uint8_t STATUS_HI_ERR = 1u << 7;

// FAULT (0x04) ビット定義, command_spec.md §4.2
constexpr uint8_t FAULT_MUX_NORSP = 1u << 0;
constexpr uint8_t FAULT_BUS_RECOVER = 1u << 1;
constexpr uint8_t FAULT_CFG_REJECT = 1u << 2;
constexpr uint8_t FAULT_WDT_RESET = 1u << 3;
constexpr uint8_t FAULT_PTR_RANGE = 1u << 4;

constexpr uint8_t CMD_IDLE = 0x00;
constexpr uint8_t CMD_BUSY = 0x01;
constexpr uint8_t CMD_FAIL = 0xFF;

constexpr uint8_t CMD_NOP = 0x00;
constexpr uint8_t CMD_CLEAR_FAULT = 0x01;
constexpr uint8_t CMD_MUX_RESET = 0x02;
constexpr uint8_t CMD_RESCAN = 0x03;
constexpr uint8_t CMD_SOFT_RESET = 0xA5;

struct SensorSnapshot {
  uint16_t angle[kChannelCount];
  uint8_t agc[kChannelCount];
  uint8_t magnetStatus[kChannelCount];
  uint8_t chOkMask;
  bool degraded;
  bool muxFault;
  uint32_t sampleCount;
};

struct BridgeConfig {
  uint8_t angleSrc;
  uint8_t pollPeriodMs;
  uint8_t statusDecim;
  uint16_t as5600Conf;
  uint8_t dirConfig;
  uint8_t chEnable;
  bool dirty;
};

struct SysStatus {
  uint8_t fault;     // FAULT(0x04): mux/バス系
  uint8_t chFault;   // CH_FAULT(0x05): ch別COMM
  uint8_t chOkMask;
  bool muxFault;
  bool degraded;
};

struct CmdMailbox {
  volatile uint8_t reqCmd;
  volatile uint32_t reqSeq;
  volatile uint32_t ackSeq;
  volatile uint8_t result;
};

struct BridgeRegs {
  uint8_t currentPtr = 0;
  bool expectPtr = true;
  uint8_t txStaging[REG_COUNT];
};

struct SamplerState {
  uint8_t statusCycle = 0;
  uint8_t fullScanFailures = 0;
  uint8_t failureStreak[kChannelCount]{};
  uint16_t appliedConf = kAs5600ConfDefault;
  uint8_t appliedDir = 0;
};

struct WriteResult {
  bool clearFault = false;
  bool softReset = false;
  bool dispatchCmd = false;
  bool applyNow = false;
  uint8_t cmdOpcode = 0;
  uint8_t dirMask = 0;
};

enum class UpstreamEventType : uint8_t {
  Write = 0,
  Read = 1,
};

struct UpstreamLogEvent {
  uint32_t timeMs;
  uint32_t sequence;
  UpstreamEventType type;
  uint8_t startReg;
  uint8_t length;
  uint8_t data[kDiagPayloadMax];
};

struct UpstreamStats {
  volatile uint32_t writeTransactions = 0;
  volatile uint32_t writeBytes = 0;
  volatile uint32_t readRequests = 0;
  volatile uint32_t readBytes = 0;
  volatile uint32_t lastActivityMs = 0;
};

struct ChannelDiagnostics {
  volatile uint32_t readSuccesses = 0;
  volatile uint32_t readFailures = 0;
  volatile uint32_t lastSuccessMs = 0;
  volatile uint32_t lastFailureMs = 0;
};

struct DownstreamStats {
  volatile uint32_t busRecoveries = 0;
  volatile uint32_t muxResets = 0;
  volatile uint32_t rescans = 0;
};

enum class DiagRequestType : uint8_t {
  None = 0,
  SensorRead,
  SensorWrite,
};

struct DiagMailbox {
  volatile uint32_t requestSequence = 0;
  volatile uint32_t resultSequence = 0;
  volatile DiagRequestType type = DiagRequestType::None;
  volatile uint8_t channel = 0;
  volatile uint8_t reg = 0;
  volatile uint8_t length = 0;
  uint8_t tx[kDiagPayloadMax]{};
  uint8_t rx[kDiagPayloadMax]{};
  volatile bool success = false;
};

struct ConsoleState {
  char line[kConsoleLineSize]{};
  size_t lineLength = 0;
  bool monitorEnabled = false;
  uint32_t monitorPeriodMs = 1000;
  uint32_t lastMonitorMs = 0;
  uint32_t pendingDiagSequence = 0;
};

SensorSnapshot gBuffers[2];
std::atomic<uint8_t> gActiveBuffer{0};

BridgeConfig gConfig{};
SysStatus gStatus{};
BridgeRegs gRegs{};
CmdMailbox gMailbox{};
SamplerState gSampler{};
DiagMailbox gDiagMailbox{};
ConsoleState gConsole{};
UpstreamStats gUpstreamStats{};
ChannelDiagnostics gChannelDiagnostics[kChannelCount]{};
DownstreamStats gDownstreamStats{};
UpstreamLogEvent gUpstreamLog[kUpstreamLogDepth]{};
volatile uint32_t gUpstreamLogSequence = 0;
volatile uint32_t gActiveReadLogSequence = 0;
uint32_t gLastMaterializedSampleCount = 0xFFFFFFFFu;  // DATA_NEW判定用（§4.1, 任意実装）
bool gReadSnapshotValid = false;
volatile uint32_t gLastPublishMs = 0u;
uint32_t gLastStatusLedServiceMs = 0u;
bool gBlueLedOn = false;
bool gYellowLedOn = false;

volatile uint8_t gChPresent = 0;
volatile uint8_t gCmdReadback = CMD_IDLE;
volatile bool gCore0Alive = false;
volatile bool gCore1Alive = false;
volatile bool gCore1Start = false;

const uint8_t kDirPins[kChannelCount] = {kDir0, kDir1, kDir2, kDir3, kDir4, kDir5};

void seedSnapshot(SensorSnapshot &snap) {
  memset(&snap, 0, sizeof(snap));
  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    snap.angle[ch] = 0xFFFFu;
    snap.agc[ch] = 0xFFu;
    snap.magnetStatus[ch] = 0u;
  }
}

void publishSnapshot(const SensorSnapshot &snap) {
  const uint8_t next = gActiveBuffer.load(std::memory_order_relaxed) ^ 1u;
  gBuffers[next] = snap;
  gActiveBuffer.store(next, std::memory_order_release);
}

SensorSnapshot snapshotNow() {
  return gBuffers[gActiveBuffer.load(std::memory_order_acquire)];
}

void applyDirMask(uint8_t dirMask) {
  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    digitalWrite(kDirPins[ch], (dirMask >> ch) & 0x01u);
  }
}

void clearFaultState() {
  gStatus.fault = 0;
  gStatus.chFault = 0;
  gStatus.muxFault = false;
  gStatus.degraded = false;
}

void initStatusLeds() {
  pinMode(kBlueLed, OUTPUT);
  pinMode(kYellowLed, OUTPUT);
  pinMode(kRedLed, OUTPUT);
  digitalWrite(kBlueLed, LOW);
  digitalWrite(kYellowLed, LOW);
  digitalWrite(kRedLed, LOW);
  gLastStatusLedServiceMs = millis();
}

void serviceStatusLeds() {
  const uint32_t now = millis();
  digitalWrite(kRedLed, (gStatus.fault != 0u || gStatus.chFault != 0u) ? HIGH : LOW);

  if (now - gLastStatusLedServiceMs < kStatusLedPeriodMs) {
    return;
  }
  gLastStatusLedServiceMs = now;

  const bool upstreamRecent =
      (gUpstreamStats.writeTransactions != 0u || gUpstreamStats.readRequests != 0u) &&
      now - gUpstreamStats.lastActivityMs <= kStatusLedPeriodMs;
  if (upstreamRecent) {
    gBlueLedOn = !gBlueLedOn;
  } else {
    gBlueLedOn = false;
  }

  const SensorSnapshot snap = snapshotNow();
  const bool publishRecent =
      snap.sampleCount != 0u && now - gLastPublishMs <= kStatusLedPeriodMs;
  if (publishRecent) {
    gYellowLedOn = !gYellowLedOn;
  } else {
    gYellowLedOn = false;
  }
  digitalWrite(kBlueLed, gBlueLedOn ? HIGH : LOW);
  digitalWrite(kYellowLed, gYellowLedOn ? HIGH : LOW);
}

uint8_t composeStatusLo(const SensorSnapshot &snap) {
  return snap.chOkMask & kChMask;
}

uint8_t composeStatusHi(const SensorSnapshot &snap, bool dataNew) {
  uint8_t hi = 0u;
  if (snap.degraded) {
    hi |= STATUS_HI_DEGRADED;
  }
  if (dataNew) {
    hi |= STATUS_HI_DATA_NEW;
  }
  if (snap.muxFault) {
    hi |= STATUS_HI_MUX_FAULT;
  }
  if (gStatus.fault != 0u || gStatus.chFault != 0u) {
    hi |= STATUS_HI_ERR;
  }
  return hi;
}

void setFault(uint8_t bits) {
  gStatus.fault |= bits;
}

void setChFault(uint8_t ch) {
  gStatus.chFault |= static_cast<uint8_t>(1u << ch);
}

uint32_t logUpstreamEvent(UpstreamEventType type, uint8_t startReg, const uint8_t *data, uint8_t length) {
  const uint32_t sequence = gUpstreamLogSequence + 1u;
  UpstreamLogEvent &event = gUpstreamLog[sequence % kUpstreamLogDepth];
  event.timeMs = millis();
  event.sequence = sequence;
  event.type = type;
  event.startReg = startReg;
  event.length = length;
  memset(event.data, 0, sizeof(event.data));
  const uint8_t copyLength = length < kDiagPayloadMax ? length : kDiagPayloadMax;
  if (data != nullptr && copyLength != 0u) {
    memcpy(event.data, data, copyLength);
  }
  std::atomic_thread_fence(std::memory_order_release);
  gUpstreamLogSequence = sequence;
  gUpstreamStats.lastActivityMs = event.timeMs;
  return sequence;
}

void appendUpstreamReadByte(uint8_t value) {
  const uint32_t sequence = gActiveReadLogSequence;
  if (sequence == 0u) {
    return;
  }
  UpstreamLogEvent &event = gUpstreamLog[sequence % kUpstreamLogDepth];
  if (event.sequence != sequence || event.type != UpstreamEventType::Read) {
    return;
  }
  if (event.length < kDiagPayloadMax) {
    event.data[event.length] = value;
  }
  if (event.length != 0xFFu) {
    event.length += 1u;
  }
  gUpstreamStats.lastActivityMs = millis();
}

void writeLe16(uint8_t *dst, uint16_t value) {
  dst[0] = static_cast<uint8_t>(value & 0xFFu);
  dst[1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
}

void writeLe32(uint8_t *dst, uint32_t value) {
  dst[0] = static_cast<uint8_t>(value & 0xFFu);
  dst[1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
  dst[2] = static_cast<uint8_t>((value >> 16) & 0xFFu);
  dst[3] = static_cast<uint8_t>((value >> 24) & 0xFFu);
}

bool isDefinedReadOffset(uint8_t reg) {
  if (reg == REG_WHO_AM_I || reg == REG_VERSION || reg == REG_STATUS_LO || reg == REG_STATUS_HI ||
      reg == REG_FAULT || reg == REG_CH_FAULT) {
    return true;
  }
  if (reg >= REG_SAMPLE_COUNT && reg < REG_SAMPLE_COUNT + 4u) {
    return true;
  }
  if (reg >= REG_CH0_ANGLE && reg < REG_CH0_ANGLE + 2u * kChannelCount) {
    return true;
  }
  if (reg == REG_STATUS_LO_M || reg == REG_STATUS_HI_M || reg == REG_SAMPLE_LO) {
    return true;
  }
  if (reg >= REG_CH0_AGC && reg < REG_CH0_AGC + kChannelCount) {
    return true;
  }
  if (reg == REG_CONFIG || reg == REG_POLL_PERIOD || reg == REG_DIR_CONFIG || reg == REG_STATUS_DECIM) {
    return true;
  }
  if (reg == REG_AS5600_CONF_LO || reg == REG_AS5600_CONF_LO + 1u) {
    return true;
  }
  if (reg == REG_CH_PRESENT || reg == REG_CH_ENABLE || reg == REG_CMD) {
    return true;
  }
  return false;
}

bool isAs5600ConfValid(uint16_t conf) {
  const uint16_t mutableMask = static_cast<uint16_t>((0x3u << 8) | (0x7u << 10));
  return (conf & ~mutableMask) == (kAs5600ConfDefault & ~mutableMask);
}

void materializeRegs(bool consumeDataNew) {
  const SensorSnapshot snap = snapshotNow();
  memset(gRegs.txStaging, 0xFF, sizeof(gRegs.txStaging));

  const bool dataNew = snap.sampleCount != gLastMaterializedSampleCount;
  if (consumeDataNew) {
    gLastMaterializedSampleCount = snap.sampleCount;
  }

  const uint8_t statusLo = composeStatusLo(snap);
  const uint8_t statusHi = composeStatusHi(snap, dataNew);

  gRegs.txStaging[REG_WHO_AM_I] = kWhoAmI;
  gRegs.txStaging[REG_VERSION] = kVersion;
  gRegs.txStaging[REG_STATUS_LO] = statusLo;
  gRegs.txStaging[REG_STATUS_HI] = statusHi;
  gRegs.txStaging[REG_FAULT] = gStatus.fault;
  gRegs.txStaging[REG_CH_FAULT] = gStatus.chFault;
  writeLe32(&gRegs.txStaging[REG_SAMPLE_COUNT], snap.sampleCount);

  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    const bool enabled = ((gConfig.chEnable >> ch) & 0x01u) != 0u;
    writeLe16(&gRegs.txStaging[REG_CH0_ANGLE + ch * 2u], enabled ? (snap.angle[ch] & 0x0FFFu) : 0xFFFFu);
    gRegs.txStaging[REG_CH0_AGC + ch] = enabled ? snap.agc[ch] : 0xFFu;
  }

  gRegs.txStaging[REG_STATUS_LO_M] = statusLo;
  gRegs.txStaging[REG_STATUS_HI_M] = statusHi;
  gRegs.txStaging[REG_SAMPLE_LO] = static_cast<uint8_t>(snap.sampleCount & 0xFFu);
  gRegs.txStaging[REG_CONFIG] = gConfig.angleSrc & 0x01u;
  gRegs.txStaging[REG_POLL_PERIOD] = gConfig.pollPeriodMs;
  gRegs.txStaging[REG_DIR_CONFIG] = gConfig.dirConfig & kChMask;
  gRegs.txStaging[REG_STATUS_DECIM] = gConfig.statusDecim;
  writeLe16(&gRegs.txStaging[REG_AS5600_CONF_LO], gConfig.as5600Conf);
  gRegs.txStaging[REG_CH_PRESENT] = gChPresent & kChMask;
  gRegs.txStaging[REG_CH_ENABLE] = gConfig.chEnable & kChMask;
  gRegs.txStaging[REG_CMD] = gCmdReadback;
}

bool dsWrite(const uint8_t addr, const uint8_t *data, const size_t len, const bool sendStop = true) {
  Wire1.beginTransmission(addr);
  if (Wire1.write(data, len) != len) {
    Wire1.endTransmission(true);
    return false;
  }
  return Wire1.endTransmission(sendStop) == 0;
}

bool dsReadRegister(const uint8_t addr, const uint8_t reg, uint8_t *dst, const size_t len) {
  if (!dsWrite(addr, &reg, 1u, false)) {
    return false;
  }
  const size_t got = Wire1.requestFrom(static_cast<int>(addr), static_cast<int>(len), static_cast<int>(true));
  if (got != len) {
    while (Wire1.available()) {
      (void)Wire1.read();
    }
    return false;
  }
  for (size_t i = 0; i < len; ++i) {
    dst[i] = static_cast<uint8_t>(Wire1.read());
  }
  return true;
}

bool muxSelect(const uint8_t ch) {
  const uint8_t mask = static_cast<uint8_t>(1u << ch);
  return dsWrite(kMuxAddr, &mask, 1u);
}

void muxReset() {
  gDownstreamStats.muxResets += 1u;
  digitalWrite(kMuxReset, LOW);
  delayMicroseconds(10);
  digitalWrite(kMuxReset, HIGH);
  delay(1);
}

bool as5600ReadAngle(uint8_t angleSrc, uint16_t &angle) {
  /* TODO(HW検証): RAW_ANGLE/SF/FTH の実効差分を実機で確認する。 */
  const uint8_t reg = angleSrc ? 0x0Eu : 0x0Cu;
  uint8_t rx[2];

  if (!dsReadRegister(kAs5600Addr, reg, rx, sizeof(rx))) {
    return false;
  }

  angle = static_cast<uint16_t>(((uint16_t)rx[0] << 8) | rx[1]) & 0x0FFFu;
  return true;
}

bool as5600ReadStatusAgc(uint8_t &statusReg, uint8_t &agc) {
  if (!dsReadRegister(kAs5600Addr, 0x0Bu, &statusReg, 1u)) {
    return false;
  }
  return dsReadRegister(kAs5600Addr, 0x1Au, &agc, 1u);
}

bool as5600WriteConf(uint16_t conf) {
  const uint8_t tx[3] = {
      0x07u,
      static_cast<uint8_t>((conf >> 8) & 0xFFu),
      static_cast<uint8_t>(conf & 0xFFu),
  };
  return dsWrite(kAs5600Addr, tx, sizeof(tx));
}

uint8_t probePresentChannels() {
  uint8_t present = 0u;

  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    uint16_t angle = 0u;
    if (muxSelect(ch) && as5600ReadAngle(0u, angle)) {
      present |= static_cast<uint8_t>(1u << ch);
    }
  }
  return present;
}

bool applyConfToPresent(uint8_t presentMask, uint16_t conf) {
  bool ok = true;

  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    if (((presentMask >> ch) & 0x01u) == 0u) {
      continue;
    }
    if (!muxSelect(ch) || !as5600WriteConf(conf)) {
      setChFault(ch);
      gStatus.degraded = true;
      ok = false;
    }
  }
  return ok;
}

void dsReinit() {
  Wire1.end();
  Wire1.setSDA(kDsSda);
  Wire1.setSCL(kDsScl);
  Wire1.setClock(kI2cBaud);
  Wire1.setTimeout(1, false);
  Wire1.begin();
}

void busLineRelease(uint8_t pin) {
  gpio_set_dir(pin, GPIO_IN);
  gpio_pull_up(pin);
}

void busLineLow(uint8_t pin) {
  gpio_put(pin, 0);
  gpio_set_dir(pin, GPIO_OUT);
}

bool busRecover() {
  gDownstreamStats.busRecoveries += 1u;
  setFault(FAULT_BUS_RECOVER);

  Wire1.end();
  gpio_set_function(kDsSda, GPIO_FUNC_SIO);
  gpio_set_function(kDsScl, GPIO_FUNC_SIO);
  busLineRelease(kDsSda);
  busLineRelease(kDsScl);
  delayMicroseconds(4);

  for (uint8_t i = 0; i < 9u && !gpio_get(kDsSda); ++i) {
    busLineLow(kDsScl);
    delayMicroseconds(4);
    busLineRelease(kDsScl);
    delayMicroseconds(4);
  }

  busLineLow(kDsSda);
  delayMicroseconds(4);
  busLineRelease(kDsScl);
  delayMicroseconds(4);
  busLineRelease(kDsSda);
  delayMicroseconds(4);

  dsReinit();
  return gpio_get(kDsSda) && gpio_get(kDsScl);
}

uint8_t bitCount(uint8_t v) {
  uint8_t c = 0u;
  while (v != 0u) {
    c = static_cast<uint8_t>(c + (v & 1u));
    v >>= 1u;
  }
  return c;
}

void applyConfigIfNeeded() {
  if (!gConfig.dirty) {
    return;
  }

  if (gSampler.appliedDir != gConfig.dirConfig) {
    applyDirMask(gConfig.dirConfig);
    gSampler.appliedDir = gConfig.dirConfig;
  }

  if (gSampler.appliedConf != gConfig.as5600Conf) {
    (void)applyConfToPresent(gChPresent & kChMask, gConfig.as5600Conf);
    gSampler.appliedConf = gConfig.as5600Conf;
  }

  gConfig.dirty = false;
}

void executeMailboxCommand() {
  if (gMailbox.reqSeq == gMailbox.ackSeq) {
    return;
  }

  switch (gMailbox.reqCmd) {
    case CMD_MUX_RESET:
      muxReset();
      gCmdReadback = applyConfToPresent(gChPresent & kChMask, gConfig.as5600Conf)
                             ? CMD_IDLE
                             : CMD_FAIL;
      break;
    case CMD_RESCAN:
      gChPresent = probePresentChannels();
      gDownstreamStats.rescans += 1u;
      (void)applyConfToPresent(gChPresent & kChMask, gConfig.as5600Conf);
      gCmdReadback = CMD_IDLE;
      break;
    default:
      setFault(FAULT_CFG_REJECT);
      gCmdReadback = CMD_FAIL;
      break;
  }

  gMailbox.result = gCmdReadback;
  std::atomic_thread_fence(std::memory_order_seq_cst);
  gMailbox.ackSeq = gMailbox.reqSeq;
}

void executeDiagMailbox() {
  const uint32_t requestSequence = gDiagMailbox.requestSequence;
  if (requestSequence == gDiagMailbox.resultSequence) {
    return;
  }

  const uint8_t channel = gDiagMailbox.channel;
  const uint8_t reg = gDiagMailbox.reg;
  const uint8_t length = gDiagMailbox.length;
  bool success = false;

  if (channel < kChannelCount && length != 0u && length <= kDiagPayloadMax && muxSelect(channel)) {
    if (gDiagMailbox.type == DiagRequestType::SensorRead) {
      uint8_t rx[kDiagPayloadMax]{};
      success = dsReadRegister(kAs5600Addr, reg, rx, length);
      for (uint8_t i = 0; i < length; ++i) {
        gDiagMailbox.rx[i] = rx[i];
      }
    } else if (gDiagMailbox.type == DiagRequestType::SensorWrite && reg != 0xFFu) {
      uint8_t tx[kDiagPayloadMax + 1u]{};
      tx[0] = reg;
      for (uint8_t i = 0; i < length; ++i) {
        tx[i + 1u] = gDiagMailbox.tx[i];
      }
      success = dsWrite(kAs5600Addr, tx, static_cast<size_t>(length) + 1u);
    }
  }

  gDiagMailbox.success = success;
  std::atomic_thread_fence(std::memory_order_release);
  gDiagMailbox.resultSequence = requestSequence;
}

void sampleOnce() {
  SensorSnapshot next = snapshotNow();
  uint8_t nextChOkMask = 0u;
  bool nextMuxFault = false;
  bool nextDegraded = (gConfig.chEnable & kChMask) == 0u;

  bool readStatusAgc = false;
  if (gConfig.statusDecim != 0u) {
    gSampler.statusCycle = static_cast<uint8_t>(gSampler.statusCycle + 1u);
    if (gSampler.statusCycle >= gConfig.statusDecim) {
      gSampler.statusCycle = 0u;
      readStatusAgc = true;
    }
  }

  uint8_t roundFailures = 0u;
  bool recoveryNeeded = false;
  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    if (((gConfig.chEnable >> ch) & 0x01u) == 0u) {
      next.angle[ch] = 0xFFFFu;
      next.agc[ch] = 0xFFu;
      next.magnetStatus[ch] = 0u;
      gSampler.failureStreak[ch] = 0u;
      continue;
    }

    uint16_t angle = 0u;
    uint8_t statusReg = 0u;
    uint8_t agc = next.agc[ch];

    if (!muxSelect(ch) || !as5600ReadAngle(gConfig.angleSrc, angle)) {
      setChFault(ch);
      gChannelDiagnostics[ch].readFailures += 1u;
      gChannelDiagnostics[ch].lastFailureMs = millis();
      nextDegraded = true;
      next.agc[ch] = 0u;
      next.magnetStatus[ch] = 0u;
      if (gSampler.failureStreak[ch] != 0xFFu) {
        gSampler.failureStreak[ch] += 1u;
      }
      recoveryNeeded = recoveryNeeded || gSampler.failureStreak[ch] >= kDsFailRecoverN;
      ++roundFailures;
      continue;
    }

    next.angle[ch] = angle;

    if (readStatusAgc) {
      if (!as5600ReadStatusAgc(statusReg, agc)) {
        setChFault(ch);
        gChannelDiagnostics[ch].readFailures += 1u;
        gChannelDiagnostics[ch].lastFailureMs = millis();
        nextDegraded = true;
        next.agc[ch] = 0u;
        next.magnetStatus[ch] = 0u;
        if (gSampler.failureStreak[ch] != 0xFFu) {
          gSampler.failureStreak[ch] += 1u;
        }
        recoveryNeeded = recoveryNeeded || gSampler.failureStreak[ch] >= kDsFailRecoverN;
        ++roundFailures;
        continue;
      }
      next.magnetStatus[ch] = statusReg;
      next.agc[ch] = agc;
    }

    gChannelDiagnostics[ch].readSuccesses += 1u;
    gChannelDiagnostics[ch].lastSuccessMs = millis();
    gSampler.failureStreak[ch] = 0u;

    const uint8_t magnet = next.magnetStatus[ch];
    const bool magnetHealthy = (magnet & 0x20u) != 0u;
    if (magnetHealthy) {
      nextChOkMask |= static_cast<uint8_t>(1u << ch);
    } else {
      nextDegraded = true;
    }
  }

  if (recoveryNeeded) {
    if (!busRecover()) {
      nextMuxFault = true;
      setFault(FAULT_MUX_NORSP);
    }
    memset(gSampler.failureStreak, 0, sizeof(gSampler.failureStreak));
  }

  if (roundFailures != 0u) {
    nextDegraded = true;
    /* TODO(HW検証): 連続失敗の閾値は実機で微調整する。 */
    if (roundFailures == bitCount(gConfig.chEnable & kChMask)) {
      gSampler.fullScanFailures = static_cast<uint8_t>(gSampler.fullScanFailures + 1u);
      if (gSampler.fullScanFailures >= kDsMuxResetN) {
        muxReset();
        nextMuxFault = true;
        setFault(FAULT_MUX_NORSP);
        gSampler.fullScanFailures = 0u;
      }
    } else {
      gSampler.fullScanFailures = 0u;
    }
  } else {
    gSampler.fullScanFailures = 0u;
  }

  next.chOkMask = nextChOkMask;
  next.muxFault = nextMuxFault;
  next.degraded = nextDegraded;
  next.sampleCount += 1u;
  publishSnapshot(next);
  gLastPublishMs = millis();
  gStatus.chOkMask = nextChOkMask;
  gStatus.muxFault = nextMuxFault;
  gStatus.degraded = nextDegraded;
}

void processRegisterWrite(uint8_t reg, uint8_t value, WriteResult &result) {
  switch (reg) {
    case REG_CONFIG:
      if ((value & 0xFEu) != 0u) {
        setFault(FAULT_CFG_REJECT);
      } else {
        gConfig.angleSrc = value & 0x01u;
        gConfig.dirty = true;
      }
      break;
    case REG_POLL_PERIOD:
      gConfig.pollPeriodMs = value;
      gConfig.dirty = true;
      break;
    case REG_DIR_CONFIG:
      if ((value & 0x40u) != 0u) {  // bit6 reserved (bit0-5=ch, bit7=APPLY_NOW)
        setFault(FAULT_CFG_REJECT);
      } else {
        gConfig.dirConfig = value & kChMask;
        gConfig.dirty = true;
        if ((value & 0x80u) != 0u) {
          result.applyNow = true;
          result.dirMask = gConfig.dirConfig;
        }
      }
      break;
    case REG_STATUS_DECIM:
      if (value == 0u) {
        setFault(FAULT_CFG_REJECT);
      } else {
        gConfig.statusDecim = value;
        gConfig.dirty = true;
      }
      break;
    case REG_AS5600_CONF_LO:
    case REG_AS5600_CONF_LO + 1: {
      uint16_t candidate = gConfig.as5600Conf;
      if (reg == REG_AS5600_CONF_LO) {
        candidate = static_cast<uint16_t>((candidate & 0xFF00u) | value);
      } else {
        candidate = static_cast<uint16_t>((candidate & 0x00FFu) | (static_cast<uint16_t>(value) << 8));
      }
      if (!isAs5600ConfValid(candidate)) {
        setFault(FAULT_CFG_REJECT);
      } else {
        gConfig.as5600Conf = candidate;
        gConfig.dirty = true;
      }
      break;
    }
    case REG_CH_ENABLE:
      if ((value & 0xC0u) != 0u || (value & kChMask) == 0u) {
        setFault(FAULT_CFG_REJECT);
      } else {
        gConfig.chEnable = value & kChMask;
        gConfig.dirty = true;
      }
      break;
    case REG_CMD:
      if (gCmdReadback == CMD_BUSY) {
        setFault(FAULT_CFG_REJECT);
        break;
      }
      switch (value) {
        case CMD_NOP:
          gCmdReadback = CMD_IDLE;
          break;
        case CMD_CLEAR_FAULT:
          result.clearFault = true;
          gCmdReadback = CMD_IDLE;
          break;
        case CMD_MUX_RESET:
        case CMD_RESCAN:
          result.dispatchCmd = true;
          result.cmdOpcode = value;
          gCmdReadback = CMD_BUSY;
          break;
        case CMD_SOFT_RESET:
          result.softReset = true;
          gCmdReadback = CMD_IDLE;
          break;
        default:
          setFault(FAULT_CFG_REJECT);
          break;
      }
      break;
    default:
      setFault(FAULT_CFG_REJECT);
      break;
  }
}

void applyWriteResult(const WriteResult &result) {
  if (result.clearFault) {
    clearFaultState();
  }
  if (result.applyNow) {
    applyDirMask(result.dirMask);
  }
  if (result.dispatchCmd) {
    gMailbox.reqCmd = result.cmdOpcode;
    std::atomic_thread_fence(std::memory_order_seq_cst);
    gMailbox.reqSeq = gMailbox.reqSeq + 1u;
  }
  if (result.softReset) {
    watchdog_reboot(0u, 0u, 0u);
  }
}

void upstreamReceive(int count) {
  if (count <= 0 || !Wire.available()) {
    return;
  }

  const int receivedCount = count;
  const uint8_t startReg = static_cast<uint8_t>(Wire.read());
  --count;
  gRegs.currentPtr = startReg;
  gRegs.expectPtr = false;
  gReadSnapshotValid = false;
  gActiveReadLogSequence = 0u;

  uint8_t logData[kDiagPayloadMax]{};
  uint8_t logLength = 0u;
  while (count-- > 0 && Wire.available()) {
    const uint8_t value = static_cast<uint8_t>(Wire.read());
    if (logLength < kDiagPayloadMax) {
      logData[logLength++] = value;
    }

    WriteResult result;
    processRegisterWrite(gRegs.currentPtr, value, result);
    gRegs.currentPtr = static_cast<uint8_t>(gRegs.currentPtr + 1u);
    applyWriteResult(result);
  }
  gRegs.expectPtr = true;
  gUpstreamStats.writeTransactions += 1u;
  gUpstreamStats.writeBytes += static_cast<uint32_t>(receivedCount);
  logUpstreamEvent(UpstreamEventType::Write, startReg, logData, logLength);
}

void upstreamRequest() {
  const uint32_t transactionStartMask =
      I2C_IC_INTR_STAT_R_START_DET_BITS | I2C_IC_INTR_STAT_R_RESTART_DET_BITS;
  if (!gReadSnapshotValid || (i2c0_hw->intr_stat & transactionStartMask) != 0u) {
    materializeRegs(/*consumeDataNew=*/true);
    gReadSnapshotValid = true;
    gUpstreamStats.readRequests += 1u;
    gActiveReadLogSequence =
        logUpstreamEvent(UpstreamEventType::Read, gRegs.currentPtr, nullptr, 0u);
  }
  uint8_t value = 0xFFu;
  const bool defined = isDefinedReadOffset(gRegs.currentPtr);

  if (gRegs.currentPtr < REG_COUNT) {
    value = gRegs.txStaging[gRegs.currentPtr];
  }
  if (!defined) {
    setFault(FAULT_PTR_RANGE);
  }

  Wire.write(&value, 1u);
  gUpstreamStats.readBytes += 1u;
  appendUpstreamReadByte(value);
  gRegs.currentPtr = static_cast<uint8_t>(gRegs.currentPtr + 1u);
}

void initSharedState() {
  gConfig.angleSrc = 0u;
  gConfig.pollPeriodMs = kPollPeriodDefault;
  gConfig.statusDecim = kStatusDecimDefault;
  gConfig.as5600Conf = kAs5600ConfDefault;
  gConfig.dirConfig = 0u;
  gConfig.chEnable = 0u;
  gConfig.dirty = false;

  gStatus = {};
  if (watchdog_enable_caused_reboot()) {
    setFault(FAULT_WDT_RESET);
  }

  gRegs = {};
  memset(gRegs.txStaging, 0xFF, sizeof(gRegs.txStaging));
  gRegs.expectPtr = true;
  gReadSnapshotValid = false;
  gActiveReadLogSequence = 0u;

  seedSnapshot(gBuffers[0]);
  seedSnapshot(gBuffers[1]);
  publishSnapshot(gBuffers[0]);
}

void bootstrapHardware() {
  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    pinMode(kDirPins[ch], OUTPUT);
  }
  pinMode(kMuxReset, OUTPUT);
  digitalWrite(kMuxReset, HIGH);
  applyDirMask(gConfig.dirConfig);

  Wire1.setSDA(kDsSda);
  Wire1.setSCL(kDsScl);
  Wire1.setClock(kI2cBaud);
  Wire1.setTimeout(1, false);
  Wire1.begin();
  delay(kAs5600PowerUpMs);

  gChPresent = probePresentChannels();
  gConfig.chEnable = gChPresent & kChMask;
  gSampler.appliedDir = gConfig.dirConfig;
  gSampler.appliedConf = gConfig.as5600Conf;

  /* TODO(HW検証): 0ch 検出時も ready を有効化する方針を実機で確認する（command_spec.md §11.4）。 */
  if ((gChPresent & kChMask) == 0u) {
    gStatus.degraded = true;
  }
  if (!applyConfToPresent(gChPresent & kChMask, gConfig.as5600Conf)) {
    gStatus.degraded = true;
  }

  gSampler.statusCycle = static_cast<uint8_t>(gConfig.statusDecim - 1u);
  sampleOnce();
}

void initUpstreamSlave() {
  Wire.setSDA(kUpSda);
  Wire.setSCL(kUpScl);
  Wire.setClock(kI2cBaud);
  Wire.begin(kBridgeAddr);
  Wire.onReceive(upstreamReceive);
  Wire.onRequest(upstreamRequest);
}

bool parseUnsigned(const char *text, uint32_t maxValue, uint32_t &value) {
  if (text == nullptr || *text == '\0' || *text == '-') {
    return false;
  }
  char *end = nullptr;
  const unsigned long parsed = strtoul(text, &end, 0);
  if (end == text || *end != '\0' || parsed > maxValue) {
    return false;
  }
  value = static_cast<uint32_t>(parsed);
  return true;
}

void printFaultNames(uint8_t fault) {
  if (fault == 0u) {
    Serial.print("none");
    return;
  }
  const char *names[] = {
      "MUX_NORSP", "BUS_RECOVER", "CFG_REJECT", "WDT_RESET", "PTR_RANGE", "res5", "res6", "res7",
  };
  bool first = true;
  for (uint8_t bit = 0; bit < 8u; ++bit) {
    if ((fault & (1u << bit)) != 0u) {
      if (!first) {
        Serial.print(',');
      }
      Serial.print(names[bit]);
      first = false;
    }
  }
}

void printChFaultNames(uint8_t chFault) {
  if (chFault == 0u) {
    Serial.print("none");
    return;
  }
  bool first = true;
  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    if ((chFault & (1u << ch)) != 0u) {
      if (!first) {
        Serial.print(',');
      }
      Serial.printf("CH%u_COMM", ch);
      first = false;
    }
  }
}

void printStatus() {
  const SensorSnapshot snap = snapshotNow();
  const uint8_t statusLo = composeStatusLo(snap);
  const bool dataNew = snap.sampleCount != gLastMaterializedSampleCount;
  const uint8_t statusHi = composeStatusHi(snap, dataNew);
  const uint8_t fault = gStatus.fault;
  const uint8_t chFault = gStatus.chFault;
  Serial.printf("STATUS status_lo=0x%02X status_hi=0x%02X fault=0x%02X ch_fault=0x%02X present=0x%02X enable=0x%02X samples=%lu cmd=0x%02X uptime_ms=%lu\r\n",
                statusLo, statusHi, fault, chFault, gChPresent & kChMask, gConfig.chEnable & kChMask,
                static_cast<unsigned long>(snap.sampleCount), gCmdReadback,
                static_cast<unsigned long>(millis()));
  Serial.printf("DOWNSTREAM bus_recoveries=%lu mux_resets=%lu rescans=%lu\r\n",
                static_cast<unsigned long>(gDownstreamStats.busRecoveries),
                static_cast<unsigned long>(gDownstreamStats.muxResets),
                static_cast<unsigned long>(gDownstreamStats.rescans));
  Serial.print("FAULTS ");
  printFaultNames(fault);
  Serial.println();
  Serial.print("CH_FAULTS ");
  printChFaultNames(chFault);
  Serial.println();
}

void printChannels() {
  const SensorSnapshot snap = snapshotNow();
  const uint8_t present = gChPresent & kChMask;
  const uint8_t enabled = gConfig.chEnable & kChMask;
  const uint8_t ok = snap.chOkMask & kChMask;
  Serial.println("CH PRESENT ENABLE OK DIR_CFG DIR_OUT ANGLE DEGREE  AGC MAG_RAW MD ML MH READ_OK READ_ERR LAST_OK_MS LAST_ERR_MS");
  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    const uint8_t bit = static_cast<uint8_t>(1u << ch);
    const uint16_t angle = snap.angle[ch];
    const uint32_t milliDegrees = angle == 0xFFFFu ? 0u : (static_cast<uint32_t>(angle) * 360000u) / 4096u;
    const uint8_t magnet = snap.magnetStatus[ch];
    const uint8_t dirPin = kDirPins[ch];
    Serial.printf("%u  %u       %u      %u  %u       %u       ",
                  ch, (present & bit) != 0u, (enabled & bit) != 0u, (ok & bit) != 0u,
                  (gConfig.dirConfig & bit) != 0u, digitalRead(dirPin) != 0);
    if (angle == 0xFFFFu) {
      Serial.print("invalid  invalid   ");
    } else {
      Serial.printf("%4u   %3lu.%03lu ", angle,
                    static_cast<unsigned long>(milliDegrees / 1000u),
                    static_cast<unsigned long>(milliDegrees % 1000u));
    }
    Serial.printf("%3u  0x%02X    %u  %u  %u  %lu %lu %lu %lu\r\n", snap.agc[ch], magnet,
                  (magnet & 0x20u) != 0u, (magnet & 0x10u) != 0u, (magnet & 0x08u) != 0u,
                  static_cast<unsigned long>(gChannelDiagnostics[ch].readSuccesses),
                  static_cast<unsigned long>(gChannelDiagnostics[ch].readFailures),
                  static_cast<unsigned long>(gChannelDiagnostics[ch].lastSuccessMs),
                  static_cast<unsigned long>(gChannelDiagnostics[ch].lastFailureMs));
  }
}

void printConfig() {
  Serial.printf("CONFIG angle_src=%s poll_period_ms=%u status_decim=%u as5600_conf=0x%04X ch_enable=0x%02X dir_config=0x%02X dir_applied=0x%02X\r\n",
                gConfig.angleSrc == 0u ? "RAW" : "FILTERED", gConfig.pollPeriodMs,
                gConfig.statusDecim, gConfig.as5600Conf, gConfig.chEnable & kChMask,
                gConfig.dirConfig & kChMask, gSampler.appliedDir & kChMask);
}

void printMasterStats() {
  uint32_t writeTransactions;
  uint32_t writeBytes;
  uint32_t readRequests;
  uint32_t readBytes;
  uint32_t lastActivityMs;
  uint32_t logSequence;
  noInterrupts();
  writeTransactions = gUpstreamStats.writeTransactions;
  writeBytes = gUpstreamStats.writeBytes;
  readRequests = gUpstreamStats.readRequests;
  readBytes = gUpstreamStats.readBytes;
  lastActivityMs = gUpstreamStats.lastActivityMs;
  logSequence = gUpstreamLogSequence;
  interrupts();
  Serial.printf("MASTER write_tx=%lu write_bytes=%lu read_req=%lu read_bytes=%lu last_activity_ms=%lu log_seq=%lu\r\n",
                static_cast<unsigned long>(writeTransactions), static_cast<unsigned long>(writeBytes),
                static_cast<unsigned long>(readRequests), static_cast<unsigned long>(readBytes),
                static_cast<unsigned long>(lastActivityMs), static_cast<unsigned long>(logSequence));
}

void clearMasterDiagnostics() {
  noInterrupts();
  gUpstreamStats.writeTransactions = 0u;
  gUpstreamStats.writeBytes = 0u;
  gUpstreamStats.readRequests = 0u;
  gUpstreamStats.readBytes = 0u;
  gUpstreamStats.lastActivityMs = 0u;
  gUpstreamLogSequence = 0u;
  gActiveReadLogSequence = 0u;
  memset(gUpstreamLog, 0, sizeof(gUpstreamLog));
  interrupts();
  Serial.println("OK master counters and log cleared");
}

void clearDownstreamDiagnostics() {
  for (uint8_t ch = 0; ch < kChannelCount; ++ch) {
    gChannelDiagnostics[ch].readSuccesses = 0u;
    gChannelDiagnostics[ch].readFailures = 0u;
    gChannelDiagnostics[ch].lastSuccessMs = 0u;
    gChannelDiagnostics[ch].lastFailureMs = 0u;
  }
  gDownstreamStats.busRecoveries = 0u;
  gDownstreamStats.muxResets = 0u;
  gDownstreamStats.rescans = 0u;
  Serial.println("OK downstream counters cleared");
}

void printUpstreamLog(uint32_t requested) {
  uint32_t latest;
  noInterrupts();
  latest = gUpstreamLogSequence;
  interrupts();
  const uint32_t available = latest < kUpstreamLogDepth ? latest : kUpstreamLogDepth;
  const uint32_t count = requested < available ? requested : available;
  const uint32_t first = latest - count + 1u;
  Serial.printf("LOG entries=%lu latest=%lu\r\n", static_cast<unsigned long>(count), static_cast<unsigned long>(latest));
  for (uint32_t sequence = first; sequence <= latest && count != 0u; ++sequence) {
    UpstreamLogEvent event;
    noInterrupts();
    event = gUpstreamLog[sequence % kUpstreamLogDepth];
    interrupts();
    if (event.sequence != sequence) {
      continue;
    }
    Serial.printf("#%lu t=%lums %c reg=0x%02X len=%u data=",
                  static_cast<unsigned long>(event.sequence), static_cast<unsigned long>(event.timeMs),
                  event.type == UpstreamEventType::Write ? 'W' : 'R', event.startReg, event.length);
    const uint8_t shown = event.length < kDiagPayloadMax ? event.length : kDiagPayloadMax;
    if (shown == 0u) {
      Serial.print('-');
    }
    for (uint8_t i = 0; i < shown; ++i) {
      Serial.printf(i == 0u ? "%02X" : " %02X", event.data[i]);
    }
    Serial.println();
  }
}

bool queueBridgeCommand(uint8_t command) {
  if (gCmdReadback == CMD_BUSY) {
    Serial.println("ERR bridge command busy");
    return false;
  }
  gCmdReadback = CMD_BUSY;
  gMailbox.reqCmd = command;
  std::atomic_thread_fence(std::memory_order_seq_cst);
  gMailbox.reqSeq = gMailbox.reqSeq + 1u;
  Serial.println("OK command queued");
  return true;
}

bool queueDiagRequest(DiagRequestType type, uint8_t channel, uint8_t reg,
                      const uint8_t *data, uint8_t length) {
  if (gConsole.pendingDiagSequence != 0u || gDiagMailbox.requestSequence != gDiagMailbox.resultSequence) {
    Serial.println("ERR sensor diagnostic busy");
    return false;
  }
  gDiagMailbox.type = type;
  gDiagMailbox.channel = channel;
  gDiagMailbox.reg = reg;
  gDiagMailbox.length = length;
  for (uint8_t i = 0; i < length; ++i) {
    gDiagMailbox.tx[i] = data == nullptr ? 0u : data[i];
    gDiagMailbox.rx[i] = 0u;
  }
  const uint32_t sequence = gDiagMailbox.requestSequence + 1u;
  std::atomic_thread_fence(std::memory_order_release);
  gDiagMailbox.requestSequence = sequence;
  gConsole.pendingDiagSequence = sequence;
  Serial.println("OK sensor command queued");
  return true;
}

void serviceDiagResult() {
  const uint32_t pending = gConsole.pendingDiagSequence;
  if (pending == 0u || gDiagMailbox.resultSequence != pending) {
    return;
  }
  std::atomic_thread_fence(std::memory_order_acquire);
  const bool success = gDiagMailbox.success;
  const DiagRequestType type = gDiagMailbox.type;
  const uint8_t channel = gDiagMailbox.channel;
  const uint8_t reg = gDiagMailbox.reg;
  const uint8_t length = gDiagMailbox.length;
  Serial.printf("SENSOR_RESULT ch=%u op=%s reg=0x%02X ok=%u data=", channel,
                type == DiagRequestType::SensorRead ? "read" : "write", reg, success);
  if (type == DiagRequestType::SensorRead && success) {
    for (uint8_t i = 0; i < length; ++i) {
      Serial.printf(i == 0u ? "%02X" : " %02X", gDiagMailbox.rx[i]);
    }
  } else {
    Serial.print('-');
  }
  Serial.println();
  gConsole.pendingDiagSequence = 0u;
}

void printHelp() {
  Serial.println("multi_i2c_bridge USB diagnostic commands:");
  Serial.println("  help                         show this help");
  Serial.println("  identity [set <16hex>]       show/provision persistent board identity");
  Serial.println("  status                       bridge summary and decoded faults");
  Serial.println("  channels                     per-channel input/output and sensor values");
  Serial.println("  config                       active bridge configuration");
  Serial.println("  monitor <100..60000|off>     periodic status/channels output [ms]");
  Serial.println("  master [clear]               upstream I2C counters / clear counters+log");
  Serial.println("  log [1..64|clear]            recent upstream master transactions");
  Serial.println("  stats clear                  clear downstream/channel counters");
  Serial.println("  rescan                       rescan downstream sensor presence");
  Serial.println("  fault clear                  clear latched faults");
  Serial.println("  mux reset                    reset TCA9548A");
  Serial.println("  ch <0..5> enable|disable     change sampling enable mask");
  Serial.println("  ch <0..5> dir <0|1>          set and immediately apply DIR output");
  Serial.println("  ch <0..5> read <reg> [len]   raw AS5600 register read, len 1..8");
  Serial.println("  ch <0..5> write <reg> <b..>  raw AS5600 write, 1..8 bytes (0xFF blocked)");
  Serial.println("  reboot                       watchdog reboot");
  Serial.println("Numbers accept decimal or 0x-prefixed hexadecimal.");
}

void executeConsoleCommand(char *line) {
  char *argv[12]{};
  size_t argc = 0u;
  char *save = nullptr;
  for (char *token = strtok_r(line, " \t", &save); token != nullptr && argc < 12u;
       token = strtok_r(nullptr, " \t", &save)) {
    for (char *p = token; *p != '\0'; ++p) {
      *p = static_cast<char>(tolower(static_cast<unsigned char>(*p)));
    }
    argv[argc++] = token;
  }
  if (argc == 0u) {
    return;
  }

  if (strcmp(argv[0], "help") == 0 || strcmp(argv[0], "?") == 0) {
    printHelp();
  } else if (strcmp(argv[0], "identity") == 0) {
    if (argc == 1u) {
      Serial.printf("IDENTITY product=multi_i2c_bridge id=%s protocol=1\r\n", gBridgeIdentity);
    } else if (argc == 3u && strcmp(argv[1], "set") == 0 && validIdentity(argv[2])) {
      if (saveBridgeIdentity(argv[2])) {
        Serial.printf("OK identity id=%s\r\n", gBridgeIdentity);
      } else {
        Serial.println("ERR identity persistence failed");
      }
    } else {
      Serial.println("ERR usage: identity [set <16hex>]");
    }
  } else if (strcmp(argv[0], "status") == 0) {
    printStatus();
  } else if (strcmp(argv[0], "channels") == 0) {
    printChannels();
  } else if (strcmp(argv[0], "config") == 0) {
    printConfig();
  } else if (strcmp(argv[0], "monitor") == 0) {
    if (argc == 2u && strcmp(argv[1], "off") == 0) {
      gConsole.monitorEnabled = false;
      Serial.println("OK monitor off");
    } else {
      uint32_t period;
      if (argc != 2u || !parseUnsigned(argv[1], 60000u, period) || period < 100u) {
        Serial.println("ERR usage: monitor <100..60000|off>");
      } else {
        gConsole.monitorPeriodMs = period;
        gConsole.monitorEnabled = true;
        gConsole.lastMonitorMs = 0u;
        Serial.printf("OK monitor period_ms=%lu\r\n", static_cast<unsigned long>(period));
      }
    }
  } else if (strcmp(argv[0], "master") == 0) {
    if (argc == 2u && strcmp(argv[1], "clear") == 0) {
      clearMasterDiagnostics();
    } else if (argc == 1u) {
      printMasterStats();
    } else {
      Serial.println("ERR usage: master [clear]");
    }
  } else if (strcmp(argv[0], "log") == 0) {
    if (argc == 2u && strcmp(argv[1], "clear") == 0) {
      clearMasterDiagnostics();
    } else {
      uint32_t count = 16u;
      if (argc > 2u || (argc == 2u && (!parseUnsigned(argv[1], kUpstreamLogDepth, count) || count == 0u))) {
        Serial.println("ERR usage: log [1..64|clear]");
      } else {
        printUpstreamLog(count);
      }
    }
  } else if (strcmp(argv[0], "stats") == 0 && argc == 2u && strcmp(argv[1], "clear") == 0) {
    clearDownstreamDiagnostics();
  } else if (strcmp(argv[0], "rescan") == 0 && argc == 1u) {
    queueBridgeCommand(CMD_RESCAN);
  } else if (strcmp(argv[0], "fault") == 0 && argc == 2u && strcmp(argv[1], "clear") == 0) {
    clearFaultState();
    Serial.println("OK faults cleared");
  } else if (strcmp(argv[0], "mux") == 0 && argc == 2u && strcmp(argv[1], "reset") == 0) {
    queueBridgeCommand(CMD_MUX_RESET);
  } else if (strcmp(argv[0], "reboot") == 0 && argc == 1u) {
    Serial.println("OK rebooting");
    Serial.flush();
    watchdog_reboot(0u, 0u, 10u);
  } else if (strcmp(argv[0], "ch") == 0) {
    uint32_t channelValue;
    if (argc < 3u || !parseUnsigned(argv[1], kChannelCount - 1u, channelValue)) {
      Serial.println("ERR usage: ch <0..5> enable|disable|dir|read|write ...");
      return;
    }
    const uint8_t channel = static_cast<uint8_t>(channelValue);
    const uint8_t bit = static_cast<uint8_t>(1u << channel);
    if (strcmp(argv[2], "enable") == 0 && argc == 3u) {
      gConfig.chEnable |= bit;
      gConfig.dirty = true;
      Serial.printf("OK ch%u enabled mask=0x%02X\r\n", channel, gConfig.chEnable & kChMask);
    } else if (strcmp(argv[2], "disable") == 0 && argc == 3u) {
      const uint8_t candidate = static_cast<uint8_t>(gConfig.chEnable & ~bit) & kChMask;
      if (candidate == 0u) {
        Serial.println("ERR at least one channel must remain enabled");
      } else {
        gConfig.chEnable = candidate;
        gConfig.dirty = true;
        Serial.printf("OK ch%u disabled mask=0x%02X\r\n", channel, candidate);
      }
    } else if (strcmp(argv[2], "dir") == 0) {
      uint32_t direction;
      if (argc != 4u || !parseUnsigned(argv[3], 1u, direction)) {
        Serial.println("ERR usage: ch <0..5> dir <0|1>");
      } else {
        gConfig.dirConfig = direction != 0u ? static_cast<uint8_t>(gConfig.dirConfig | bit)
                                            : static_cast<uint8_t>(gConfig.dirConfig & ~bit);
        applyDirMask(gConfig.dirConfig);
        gConfig.dirty = true;
        Serial.printf("OK ch%u dir=%lu output=%u\r\n", channel,
                      static_cast<unsigned long>(direction), digitalRead(kDirPins[channel]) != 0);
      }
    } else if (strcmp(argv[2], "read") == 0) {
      uint32_t reg;
      uint32_t length = 1u;
      if ((argc != 4u && argc != 5u) || !parseUnsigned(argv[3], 0xFFu, reg) ||
          (argc == 5u && !parseUnsigned(argv[4], kDiagPayloadMax, length)) || length == 0u) {
        Serial.println("ERR usage: ch <0..5> read <reg> [1..8]");
      } else {
        queueDiagRequest(DiagRequestType::SensorRead, channel, static_cast<uint8_t>(reg), nullptr,
                         static_cast<uint8_t>(length));
      }
    } else if (strcmp(argv[2], "write") == 0) {
      uint32_t reg;
      const size_t dataLength = argc >= 5u ? argc - 4u : 0u;
      uint8_t data[kDiagPayloadMax]{};
      const bool regValid = argc >= 5u && parseUnsigned(argv[3], 0xFFu, reg);
      if (regValid && reg == 0xFFu) {
        Serial.println("ERR burn register blocked");
        return;
      }
      bool valid = regValid && dataLength <= kDiagPayloadMax;
      for (size_t i = 0; valid && i < dataLength; ++i) {
        uint32_t value;
        valid = parseUnsigned(argv[i + 4u], 0xFFu, value);
        data[i] = static_cast<uint8_t>(value);
      }
      if (!valid) {
        Serial.println("ERR usage: ch <0..5> write <reg 0x00..0xFE> <byte...> (1..8 bytes)");
      } else {
        const uint32_t endReg = reg + dataLength - 1u;
        if (reg <= 0x08u && endReg >= 0x07u) {
          Serial.println("WARN direct CONF write may be overwritten; use AS5600_CONF for persistent settings");
        }
        queueDiagRequest(DiagRequestType::SensorWrite, channel, static_cast<uint8_t>(reg), data,
                         static_cast<uint8_t>(dataLength));
      }
    } else {
      Serial.println("ERR usage: ch <0..5> enable|disable|dir|read|write ...");
    }
  } else {
    Serial.println("ERR unknown command; type help");
  }
}

void pollConsole() {
  size_t processed = 0u;
  while (Serial.available() && processed++ < 64u) {
    const int incoming = Serial.read();
    if (incoming < 0) {
      break;
    }
    const char ch = static_cast<char>(incoming);
    if (ch == '\r' || ch == '\n') {
      if (gConsole.lineLength != 0u) {
        gConsole.line[gConsole.lineLength] = '\0';
        executeConsoleCommand(gConsole.line);
        gConsole.lineLength = 0u;
      }
    } else if (ch == '\b' || ch == 0x7Fu) {
      if (gConsole.lineLength != 0u) {
        --gConsole.lineLength;
      }
    } else if (isprint(static_cast<unsigned char>(ch))) {
      if (gConsole.lineLength + 1u < sizeof(gConsole.line)) {
        gConsole.line[gConsole.lineLength++] = ch;
      } else {
        gConsole.lineLength = 0u;
        Serial.println("ERR command line too long");
      }
    }
  }
}

void serviceMonitor() {
  if (!gConsole.monitorEnabled || !Serial) {
    return;
  }
  const uint32_t now = millis();
  if (now - gConsole.lastMonitorMs < gConsole.monitorPeriodMs) {
    return;
  }
  gConsole.lastMonitorMs = now;
  printStatus();
  printChannels();
}

}  // namespace

void setup() {
#if MULTI_I2C_BRIDGE_USB_CONSOLE
  Serial.begin(115200);
  loadBridgeIdentity();
#endif
  initSharedState();
  initStatusLeds();
  bootstrapHardware();
  initUpstreamSlave();
  watchdog_start_tick(12);
  watchdog_enable(kWdtTimeoutMs, true);
  gCore1Start = true;
}

void loop() {
#if MULTI_I2C_BRIDGE_USB_CONSOLE
  pollConsole();
  serviceDiagResult();
  serviceMonitor();
#endif
  serviceStatusLeds();
  gCore0Alive = true;
  if (gCore0Alive && gCore1Alive) {
    watchdog_update();
    gCore0Alive = false;
    gCore1Alive = false;
  }
  delay(1);
}

void setup1() {
  while (!gCore1Start) {
    delay(1);
  }
}

void loop1() {
  const uint32_t cycleStartMs = millis();
  executeMailboxCommand();
#if MULTI_I2C_BRIDGE_USB_CONSOLE
  executeDiagMailbox();
#endif
  sampleOnce();
  applyConfigIfNeeded();
  gCore1Alive = true;
  if (gConfig.pollPeriodMs != 0u) {
    const uint32_t elapsedMs = millis() - cycleStartMs;
    if (elapsedMs < gConfig.pollPeriodMs) {
      delay(gConfig.pollPeriodMs - elapsedMs);
    }
  }
}

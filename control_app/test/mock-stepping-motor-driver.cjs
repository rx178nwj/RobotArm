const { Duplex } = require("node:stream");

class MockSteppingMotorDriver extends Duplex {
  constructor(boardId, options = {}) {
    super();
    this.boardId = boardId;
    this.options = options;
    this.input = "";
    this.commands = [];
  }

  _read() {}

  _write(chunk, _encoding, callback) {
    this.input += chunk.toString("utf8");
    let newline = this.input.indexOf("\n");
    while (newline >= 0) {
      const command = this.input.slice(0, newline).trim();
      this.input = this.input.slice(newline + 1);
      if (command) this.handleCommand(command);
      newline = this.input.indexOf("\n");
    }
    callback();
  }

  handleCommand(command) {
    this.commands.push({ command, timestamp: Date.now() });
    if (command === "GET BOARD_ID") return this.reply(`OK ${this.boardId}`);
    if (command === "MOVETO 0 -999") return this.reply("ERR E006 SOFT_LIMIT");
    if (command === "VEL 0 777") return;
    if (command === "ESTOP" && this.options.ignoreEstop) return;
    this.reply("OK");
    if (command === "HOME 0") setTimeout(() => this.reply("EVT HOME_DONE 0"), 10);
  }

  reply(line) {
    setImmediate(() => this.push(`${line}\n`));
  }
}

module.exports = { MockSteppingMotorDriver };

const fs = require("node:fs");
const path = require("node:path");

const TARGETS = {
  "macos-arm64": {
    executable: "llama-server",
    libraryExtension: ".dylib",
    format: "macho",
    machine: 0x0100000c,
    machineLabel: "arm64",
  },
  "macos-x64": {
    executable: "llama-server",
    libraryExtension: ".dylib",
    format: "macho",
    machine: 0x01000007,
    machineLabel: "x86_64",
  },
  "windows-x64": {
    executable: "llama-server.exe",
    libraryExtension: ".dll",
    format: "pe",
    machine: 0x8664,
    machineLabel: "x86_64",
  },
};

function fail(message) {
  throw new Error(`llama.cpp runtime validation failed: ${message}`);
}

function binaryMachine(filePath, format) {
  const buffer = fs.readFileSync(filePath);
  if (format === "macho") {
    if (buffer.length < 8 || buffer.readUInt32LE(0) !== 0xfeedfacf) {
      fail(`${filePath} is not a 64-bit little-endian Mach-O binary`);
    }
    return buffer.readUInt32LE(4);
  }

  if (buffer.length < 64 || buffer.toString("ascii", 0, 2) !== "MZ") {
    fail(`${filePath} is not a PE binary`);
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0") {
    fail(`${filePath} has an invalid PE header`);
  }
  return buffer.readUInt16LE(peOffset + 4);
}

function validateBinary(filePath, target) {
  if (!fs.existsSync(filePath)) fail(`missing ${filePath}`);
  const actual = binaryMachine(filePath, target.format);
  if (actual !== target.machine) {
    fail(`${filePath} is not ${target.machineLabel} (machine 0x${actual.toString(16)})`);
  }
}

function main() {
  const targetName = process.argv[2];
  const target = TARGETS[targetName];
  if (!target) {
    fail(`unknown target ${JSON.stringify(targetName)}; expected ${Object.keys(TARGETS).join(", ")}`);
  }

  const frontendDir = path.resolve(__dirname, "..");
  const sourceDir = path.join(frontendDir, "vendor", "llama.cpp", targetName);
  const stagingDir = path.join(frontendDir, ".llama-runtime");
  if (!fs.existsSync(sourceDir)) fail(`missing runtime directory ${sourceDir}`);

  const executable = path.join(sourceDir, target.executable);
  validateBinary(executable, target);
  const libraries = fs.readdirSync(sourceDir).filter((name) => name.endsWith(target.libraryExtension));
  if (libraries.length === 0) fail(`no ${target.libraryExtension} libraries found in ${sourceDir}`);
  for (const library of libraries) validateBinary(path.join(sourceDir, library), target);

  if (target.format === "macho") {
    const mode = fs.statSync(executable).mode;
    if ((mode & 0o111) === 0) fail(`${executable} is not executable`);
  }

  const backendPath = process.argv[3];
  if (backendPath) validateBinary(path.resolve(frontendDir, backendPath), target);

  fs.rmSync(stagingDir, { recursive: true, force: true });
  fs.cpSync(sourceDir, stagingDir, { recursive: true, dereference: false });
  process.stdout.write(`Prepared llama.cpp ${targetName} runtime at ${stagingDir}\n`);
}

main();

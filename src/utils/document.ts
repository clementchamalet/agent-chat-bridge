import fs from "node:fs";
import { isSensitivePath } from "./sensitivePath.js";

/** Recheck selected files at delivery time; a picker entry may have changed. */
export function readDocument(filePath: string, maxBytes: number): Buffer {
  const resolved = fs.realpathSync(filePath);
  if (isSensitivePath(filePath) || isSensitivePath(resolved) || fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error("Cannot send a sensitive file or symbolic link");
  }
  const fd = fs.openSync(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new Error("Document must be a regular file");
    if (stat.size > maxBytes) throw new Error("Document exceeds the bridge size limit");
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return buffer.subarray(0, offset);
  } finally {
    fs.closeSync(fd);
  }
}

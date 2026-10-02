import { describe, expect, it } from "vitest";
import { readLimitedResponse } from "./readLimitedResponse.js";

describe("readLimitedResponse", () => {
  it("returns a response within the byte limit", async () => {
    await expect(readLimitedResponse(new Response("hello"), 5)).resolves.toEqual(Buffer.from("hello"));
  });

  it("rejects a declared oversize response", async () => {
    await expect(readLimitedResponse(new Response("hello"), 4)).rejects.toThrow("download limit");
  });

  it("stops reading when a stream exceeds the limit", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    await expect(readLimitedResponse(new Response(body), 5)).rejects.toThrow("download limit");
  });
});

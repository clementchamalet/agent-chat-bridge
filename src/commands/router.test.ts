import { describe, expect, it } from "vitest";
import { isBridgeCommand, routeCommand } from "./router.js";

describe("command routing", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
    "ignores inherited property /%s",
    async (name) => {
      expect(isBridgeCommand(`/${name}`)).toBe(false);
      await expect(routeCommand({} as never, "test", {} as never, `/${name}`)).resolves.toBeUndefined();
    },
  );
});

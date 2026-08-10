import { expect, test } from "bun:test";
import { greeting } from "../src/greeting.ts";

test("formats a complete greeting", () => {
  expect(greeting("Ada")).toBe("Hello, Ada!");
});

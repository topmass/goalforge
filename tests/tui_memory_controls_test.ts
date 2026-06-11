import { assertEquals } from "@std/assert";
import { parseResetMemoryConfirmation } from "../src/tui/memory_controls.ts";

Deno.test("reset memory confirmation requires uppercase RESET", () => {
  assertEquals(parseResetMemoryConfirmation(""), { confirmed: false });
  assertEquals(parseResetMemoryConfirmation("reset"), { confirmed: false });
  assertEquals(parseResetMemoryConfirmation(" RESET "), { confirmed: true });
});

Deno.test("reset memory confirmation accepts an explicit replacement id", () => {
  assertEquals(parseResetMemoryConfirmation("RESET loopforge-main"), {
    confirmed: true,
    threadId: "loopforge-main",
  });
  assertEquals(parseResetMemoryConfirmation("RESET   custom-main"), {
    confirmed: true,
    threadId: "custom-main",
  });
});

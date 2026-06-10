import { assertEquals } from "@std/assert";
import { decodeControlKey, decodePromptInput, normalizePromptText } from "../src/tui/input.ts";

Deno.test("prompt input normalizes bracketed paste into plain text", () => {
  assertEquals(
    normalizePromptText("\x1b[200~Build CRM\nwith contacts\tand deals\x1b[201~"),
    "Build CRM with contacts and deals",
  );
});

Deno.test("prompt input keeps control keys separate from pasted text", () => {
  assertEquals(decodePromptInput("\r"), { kind: "key", key: "enter" });
  assertEquals(decodePromptInput("\x7f"), { kind: "key", key: "backspace" });
  assertEquals(decodePromptInput("Build a detailed feature"), {
    kind: "text",
    text: "Build a detailed feature",
  });
});

Deno.test("control key decoder supports paging keys for scrollable panels", () => {
  assertEquals(decodeControlKey("\x1b[5~"), "pageup");
  assertEquals(decodeControlKey("\x1b[6~"), "pagedown");
});

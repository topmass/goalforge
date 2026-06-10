export type PromptInput =
  | { kind: "key"; key: string }
  | { kind: "text"; text: string };

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";

export function decodePromptInput(sequence: string): PromptInput | null {
  const key = decodeControlKey(sequence);
  if (key) {
    return { kind: "key", key };
  }
  const text = normalizePromptText(sequence);
  return text ? { kind: "text", text } : null;
}

export function normalizePromptText(value: string): string {
  return value
    .replaceAll(BRACKETED_PASTE_START, "")
    .replaceAll(BRACKETED_PASTE_END, "")
    .replace(/\r\n/g, "\n")
    .replace(/[\r\n\t]+/g, " ")
    .split("")
    .filter(isPromptCharacter)
    .join("")
    .replace(/\s+/g, " ");
}

function isPromptCharacter(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 32 && code !== 127;
}

export function decodeControlKey(sequence: string): string | null {
  if (sequence === "\u0003") return "q";
  if (sequence === "\u001b[A") return "up";
  if (sequence === "\u001b[B") return "down";
  if (sequence === "\u001b[5~") return "pageup";
  if (sequence === "\u001b[6~") return "pagedown";
  if (sequence === "\u001b[3~") return "delete";
  if (sequence === "\t") return "tab";
  if (sequence === "\r" || sequence === "\n") return "enter";
  if (sequence === "\u001b") return "escape";
  if (sequence === "\u007f" || sequence === "\b") return "backspace";
  if (sequence.length === 1 && sequence >= " ") return sequence;
  return null;
}

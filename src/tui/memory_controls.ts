export interface ResetMemoryConfirmation {
  confirmed: boolean;
  threadId?: string;
}

export function parseResetMemoryConfirmation(value: string): ResetMemoryConfirmation {
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "RESET") {
    return { confirmed: true };
  }
  if (text.startsWith("RESET ")) {
    const threadId = text.slice("RESET ".length).trim();
    return threadId ? { confirmed: true, threadId } : { confirmed: true };
  }
  return { confirmed: false };
}

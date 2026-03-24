export type CommandPolicyAction = "allow" | "deny";

export type CommandPolicyResult = {
  action: CommandPolicyAction;
  matchedRule?: string;
};

type StructuredCommand = {
  head: string;
  tail: string[];
};

function tokenizeCommand(command: string): StructuredCommand {
  const tokens = Array.from(command.matchAll(/"[^"]*"|'[^']*'|\S+/g), (match) => match[0]);
  const [head = "", ...tail] = tokens;
  return { head, tail };
}

function matchWildcard(input: string, pattern: string): boolean {
  const normalizedInput = input.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/");
  let escaped = normalizedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  if (escaped.endsWith(" .*")) {
    escaped = escaped.slice(0, -3) + "( .*)?";
  }

  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(
    normalizedInput
  );
}

function matchSequence(items: string[], patterns: string[]): boolean {
  if (patterns.length === 0) {
    return true;
  }

  const [pattern, ...rest] = patterns;
  if (pattern === "*") {
    return matchSequence(items, rest);
  }

  for (let index = 0; index < items.length; index += 1) {
    if (matchWildcard(items[index] ?? "", pattern) && matchSequence(items.slice(index + 1), rest)) {
      return true;
    }
  }

  return false;
}

function matchStructuredCommand(input: StructuredCommand, pattern: string): boolean {
  const parts = pattern.trim().split(/\s+/);
  const [head = "*", ...tail] = parts;
  if (!matchWildcard(input.head, head)) {
    return false;
  }

  if (tail.length === 0) {
    return true;
  }

  return matchSequence(input.tail, tail);
}

export function evaluateCommandPolicy(
  command: string,
  rules: Record<string, CommandPolicyAction>
): CommandPolicyResult {
  const structured = tokenizeCommand(command);
  const ordered = Object.entries(rules).sort(([left], [right]) => {
    if (left.length !== right.length) {
      return left.length - right.length;
    }
    return left.localeCompare(right);
  });

  let matchedRule: string | undefined;
  let action: CommandPolicyAction = "deny";

  for (const [pattern, nextAction] of ordered) {
    if (!matchStructuredCommand(structured, pattern)) {
      continue;
    }
    matchedRule = pattern;
    action = nextAction;
  }

  return { action, matchedRule };
}


const separator = "/" as const;

export const pathSeparator = separator;

export const normalizePath = (input: string): string => {
  const absolute = input.startsWith(separator);
  const parts: string[] = [];
  for (const part of input.split(separator)) {
    if (part.length === 0 || part === ".") continue;
    if (part === "..") {
      const previous = parts.at(-1);
      if (previous !== undefined && previous !== "..") parts.pop();
      else if (!absolute) parts.push(part);
      continue;
    }
    parts.push(part);
  }
  const body = parts.join(separator);
  if (absolute) return body.length === 0 ? separator : `${separator}${body}`;
  return body.length === 0 ? "." : body;
};

export const joinPath = (...segments: readonly string[]): string =>
  normalizePath(segments.filter((segment) => segment.length > 0).join(separator));

export const resolvePath = (...segments: readonly string[]): string => {
  const resolved: string[] = [];
  let absolute = false;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment === undefined || segment.length === 0) continue;
    resolved.unshift(segment);
    if (segment.startsWith(separator)) {
      absolute = true;
      break;
    }
  }
  if (!absolute) resolved.unshift(Bun.cwd);
  return normalizePath(resolved.join(separator));
};

export const relativePath = (from: string, to: string): string => {
  const fromParts = splitAbsolute(resolvePath(from));
  const toParts = splitAbsolute(resolvePath(to));
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common])
    common += 1;
  const parts = [
    ...Array.from({ length: fromParts.length - common }, () => ".."),
    ...toParts.slice(common),
  ];
  return parts.join(separator);
};

export const dirnamePath = (input: string): string => {
  const normalized = normalizePath(input);
  if (normalized === separator || normalized === ".") return normalized;
  const index = normalized.lastIndexOf(separator);
  if (index < 0) return ".";
  if (index === 0) return separator;
  return normalized.slice(0, index);
};

const splitAbsolute = (input: string): readonly string[] =>
  normalizePath(input).split(separator).filter((part) => part.length > 0 && part !== ".");

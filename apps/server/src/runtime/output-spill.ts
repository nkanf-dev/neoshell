import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type TruncateCommandOutputOptions = {
  outputDir: string;
  maxLines?: number;
  maxBytes?: number;
};

export type TruncateCommandOutputResult = {
  outputPreview: string;
  truncated: boolean;
  outputPath?: string;
};

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

export async function truncateCommandOutput(
  text: string,
  options: TruncateCommandOutputOptions
): Promise<TruncateCommandOutputResult> {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const lines = text.split(/\r?\n/);
  const totalBytes = Buffer.byteLength(text, "utf8");

  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return {
      outputPreview: text,
      truncated: false
    };
  }

  const out: string[] = [];
  let bytes = 0;
  for (const line of lines.slice(0, maxLines)) {
    const nextSize = Buffer.byteLength(line, "utf8") + (out.length > 0 ? 1 : 0);
    if (bytes + nextSize > maxBytes) {
      break;
    }
    out.push(line);
    bytes += nextSize;
  }

  const preview = out.join("\n");
  await mkdir(options.outputDir, { recursive: true });
  const outputPath = join(options.outputDir, `spill-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
  await writeFile(outputPath, text, "utf8");

  return {
    outputPreview: `${preview}\n\n...truncated...\nFull output saved to ${outputPath}`,
    truncated: true,
    outputPath
  };
}


/**
 * compact-model — compaction that stays small, run by a model you choose.
 *
 * Pi's built-in compaction asks the session model to rewrite the previous
 * summary while preserving everything in it, and re-emits every file path the
 * session ever touched. On a long session both only grow: one session here
 * reached a 220k-character summary, 82% of it file paths, that took ten
 * minutes to rewrite about once an hour.
 *
 * This extension answers `session_before_compact` itself and:
 *   - summarizes with the model named in the config, at a thinking level of its
 *     own rather than the session's (default: the session's model, thinking off);
 *   - gives the summary a size budget and tells the model to drop finished
 *     detail instead of accumulating it;
 *   - keeps only the most recently touched file paths;
 *   - splits the history over several requests when it does not fit the chosen
 *     model's context window.
 *
 * Any failure falls through to Pi's built-in compaction, so this extension can
 * never leave a session uncompacted.
 *
 * Config:  <agent dir>/compact-model.json, read again on every compaction.
 * Command: /compact-model opens a list of the available models to pick from,
 *          then a list of the thinking levels the chosen model supports.
 *          /compact-model <part of a model name> narrows the model list;
 *          /compact-model thinking [level] changes the thinking level alone;
 *          /compact-model status | session | on | off do what they say.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  type SimpleStreamOptions,
  type Usage,
  uuidv7,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  type ExtensionAPI,
  type ExtensionContext,
  getAgentDir,
  serializeConversation,
} from "@earendil-works/pi-coding-agent";

const CONFIG_FILE = "compact-model.json";
const STATUS_KEY = "compact-model";
/** Marks compaction details written here, so the next run knows its lists are in recency order. */
const DETAILS_MARK = "compact-model";
/** Pi caps tool results at this many characters when serializing; tool-call arguments get the same cap here. */
const ARG_MAX_CHARS = 2000;
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_OUTPUT = 8192;
/** Tokens set aside for the instructions wrapped around the conversation. */
const PROMPT_OVERHEAD = 1500;
const TRANSIENT_ERROR =
  /rate.?limit|too many requests|\b429\b|\b5\d\d\b|overload|high demand|capacity|unavailable|temporar|time.?out|terminated|socket|ECONN|EPIPE|fetch failed|network/i;

type Level = ReturnType<typeof getSupportedThinkingLevels>[number];

const LEVELS: readonly Level[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const isLevel = (value: unknown): value is Level => LEVELS.includes(value as Level);
/** Thinking is billed against the same output limit as the summary, so a request asks for this many times the room. */
const OUTPUT_FACTOR: Record<Level, number> = { off: 1, minimal: 2, low: 2, medium: 2, high: 3, xhigh: 4, max: 4 };

interface Config {
  /** false hands compaction back to Pi. */
  enabled: boolean;
  /** "provider/modelId", or null to use whatever model the session is on. */
  model: string | null;
  /** Thinking level for the summary request. A model that lacks this level gets the nearest one it has. */
  thinkingLevel: Level;
  /** Size budget for the summary text, before the file lists. */
  maxSummaryTokens: number;
  maxModifiedFiles: number;
  maxReadFiles: number;
  /** Extra attempts after a rate limit or other transient provider error. */
  retries: number;
}

const DEFAULTS: Config = {
  enabled: true,
  model: null,
  thinkingLevel: "off",
  maxSummaryTokens: 6000,
  maxModifiedFiles: 60,
  maxReadFiles: 20,
  retries: 3,
};

type ChatModel = NonNullable<ExtensionContext["model"]>;

const configPath = () => join(getAgentDir(), CONFIG_FILE);

function readRawConfig(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(configPath(), "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("顶层必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

/** Missing file or fields mean defaults. A file that cannot be used is reported, and defaults apply. */
function readConfig(): { config: Config; problem?: string } {
  let raw: Record<string, unknown>;
  try {
    raw = readRawConfig();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { config: { ...DEFAULTS } };
    return { config: { ...DEFAULTS }, problem: `${configPath()} 无法读取，已按默认设置压缩：${(error as Error).message}` };
  }
  const count = (key: keyof Config, min: number): number => {
    const value = raw[key];
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min ? value : (DEFAULTS[key] as number);
  };
  const level = raw.thinkingLevel;
  const badLevel = level !== undefined && !isLevel(level);
  return {
    problem: badLevel
      ? `${configPath()} 里的 thinkingLevel ${JSON.stringify(level)} 无效（可用：${LEVELS.join(" / ")}），已按 ${DEFAULTS.thinkingLevel} 处理`
      : undefined,
    config: {
      enabled: raw.enabled !== false,
      model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null,
      thinkingLevel: isLevel(level) ? level : DEFAULTS.thinkingLevel,
      maxSummaryTokens: count("maxSummaryTokens", 500),
      maxModifiedFiles: count("maxModifiedFiles", 0),
      maxReadFiles: count("maxReadFiles", 0),
      retries: count("retries", 0),
    },
  };
}

/** Change some fields and leave the rest of the file as the user wrote it. */
function updateConfig(patch: Partial<Config>): void {
  let raw: Record<string, unknown> = {};
  try {
    raw = readRawConfig();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...raw, ...patch }, null, 2)}\n`);
  renameSync(temporary, path);
}

const modelKey = (model: ChatModel) => `${model.provider}/${model.id}`;

/** Model IDs may contain slashes; provider names do not, so the first slash separates them. */
function findModel(ctx: ExtensionContext, key: string): ChatModel | undefined {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return undefined;
  return ctx.modelRegistry.find(key.slice(0, slash), key.slice(slash + 1));
}

/** The configured model, or the session's model when none is configured or the configured one is unusable. */
function pickModel(ctx: ExtensionContext, config: Config): { model?: ChatModel; warning?: string } {
  if (!config.model) return { model: ctx.model };
  const model = findModel(ctx, config.model);
  if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return { model };
  const reason = model ? "没有可用凭据" : "不存在";
  return { model: ctx.model, warning: `compact-model：指定的模型 ${config.model} ${reason}，本次改用会话模型压缩。` };
}

/** Deliberately high, so a request planned to fit does fit: CJK runs about a token per character, the rest about three characters per token. */
function estimateTokens(text: string): number {
  let wide = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) > 0x2e7f) wide++;
  return Math.ceil(wide * 1.2 + (text.length - wide) / 3);
}

/** Cut text to about `tokens`, keeping its start and end. */
function clip(text: string, tokens: number): string {
  const estimated = estimateTokens(text);
  if (estimated <= tokens) return text;
  const keep = Math.max(0, Math.floor((text.length * tokens) / estimated) - 60);
  const head = Math.ceil(keep * 0.6);
  const tail = keep - head;
  return `${text.slice(0, head)}\n[... ${text.length - keep} characters omitted ...]\n${tail > 0 ? text.slice(-tail) : ""}`;
}

function shortenStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > ARG_MAX_CHARS
      ? `${value.slice(0, ARG_MAX_CHARS)}\n[... ${value.length - ARG_MAX_CHARS} more characters truncated]`
      : value;
  }
  if (Array.isArray(value)) return value.map(shortenStrings);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, shortenStrings(item)]));
  }
  return value;
}

/** A copy whose tool-call arguments are capped. Whole files passed to `write` or `edit` say nothing a summary needs beyond the path. */
function capToolArguments<T>(message: T): T {
  const candidate = message as { role?: string; content?: unknown };
  if (candidate.role !== "assistant" || !Array.isArray(candidate.content)) return message;
  const content = candidate.content.map((block) =>
    block?.type === "toolCall" ? { ...block, arguments: shortenStrings(block.arguments) } : block,
  );
  return { ...candidate, content } as T;
}

/** Split the serialized messages into as few requests as fit the budget. */
function packChunks(pieces: string[], budget: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let used = 0;
  for (const piece of pieces) {
    const fitted = clip(piece, budget);
    const size = estimateTokens(fitted) + 2;
    if (current.length > 0 && used + size > budget) {
      chunks.push(current.join("\n\n"));
      current = [];
      used = 0;
    }
    current.push(fitted);
    used += size;
  }
  if (current.length > 0) chunks.push(current.join("\n\n"));
  return chunks;
}

const FILE_LISTS = /\s*<(read-files|modified-files)>[\s\S]*?<\/\1>/g;

/** A stored summary without its file lists. They are rebuilt from `details`, not rewritten by the model. */
const stripFileLists = (summary: string) => summary.replace(FILE_LISTS, "").trim();

function formatFileLists(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

/** Paths passed to read / write / edit, in the order they were used, including calls made from codemode scripts. */
function touchedFiles(messages: readonly unknown[]): { read: string[]; modified: string[] } {
  const read: string[] = [];
  const modified: string[] = [];
  const note = (name: unknown, args: unknown) => {
    const path = (args as { path?: unknown } | null | undefined)?.path;
    if (typeof path !== "string" || !path) return;
    if (name === "read") read.push(path);
    else if (name === "write" || name === "edit") modified.push(path);
  };
  for (const message of messages as Array<Record<string, any>>) {
    if (message.role === "toolResult") {
      for (const call of message.nestedCalls?.calls ?? []) note(call?.name, call?.arguments);
    } else if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) if (block?.type === "toolCall") note(block.name, block.arguments);
    }
  }
  return { read, modified };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The file lists stored by the newest compaction on this branch, oldest path first. */
function previousFiles(branchEntries: readonly unknown[], config: Config): { read: string[]; modified: string[] } {
  const entries = branchEntries as Array<{ type?: string; details?: Record<string, unknown> }>;
  let details: Record<string, unknown> | undefined;
  for (let i = entries.length - 1; i >= 0 && !details; i--) {
    if (entries[i].type === "compaction") details = entries[i].details ?? {};
  }
  if (!details) return { read: [], modified: [] };
  const read = strings(details.readFiles);
  const modified = strings(details.modifiedFiles);
  if (details.by === DETAILS_MARK) return { read, modified };
  // Pi sorts its lists by name, so cutting one keeps an arbitrary slice of the
  // alphabet rather than the recent files. Carry a list of Pi's only when it fits whole.
  return {
    read: read.length <= config.maxReadFiles ? read : [],
    modified: modified.length <= config.maxModifiedFiles ? modified : [],
  };
}

/** Older paths followed by newer ones, each path once at its latest position, limited to the newest `cap`. */
function newest(older: string[], newer: string[], cap: number): string[] {
  const order = new Set(older);
  for (const path of newer) {
    order.delete(path);
    order.add(path);
  }
  return cap > 0 ? [...order].slice(-cap) : [];
}

/** Add every numeric field of `next`, nested cost included, into `total`. */
function addNumbers(total: Record<string, unknown>, next: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(next)) {
    const current = total[key];
    if (typeof value === "number") {
      total[key] = (typeof current === "number" ? current : 0) + value;
    } else if (typeof value === "object" && value !== null) {
      if (typeof current !== "object" || current === null) total[key] = {};
      addNumbers(total[key] as Record<string, unknown>, value as Record<string, unknown>);
    }
  }
}

function addUsage(total: Usage | undefined, next: Usage | undefined): Usage | undefined {
  if (!next) return total;
  if (!total) return structuredClone(next);
  addNumbers(total as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  return total;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const SYSTEM_PROMPT = `You maintain the rolling summary of a long coding session between a user and an AI assistant.

Do NOT continue the conversation. Do NOT answer questions found in it. Output ONLY the summary, in the format requested.`;

function buildPrompt(input: {
  conversation: string;
  previous: string;
  budget: number;
  part: number;
  parts: number;
  endsMidTurn: boolean;
  focus?: string;
}): string {
  const { conversation, previous, budget, part, parts, endsMidTurn, focus } = input;
  const notes: string[] = [];
  if (parts > 1) {
    notes.push(
      `The new messages are delivered in ${parts} parts. This is part ${part}${part < parts ? "; later parts follow in further updates" : ", the last one"}.`,
    );
  }
  if (endsMidTurn && part === parts) {
    notes.push(
      "These messages stop in the middle of a task. The assistant's following steps are kept verbatim after this summary, so describe the task as still in progress.",
    );
  }
  if (focus) notes.push(`Additional focus from the user: ${focus}`);

  return `<conversation>
${conversation}
</conversation>

${previous ? `<previous-summary>\n${previous}\n</previous-summary>\n\n` : ""}${
    previous
      ? "The messages in <conversation> are NEW. Fold them into the summary in <previous-summary> and write the updated summary."
      : "Write a summary of the messages in <conversation>."
  }
Another assistant will continue the work from this summary and the most recent messages only, so keep what is needed to continue and let the rest go.${notes.length > 0 ? `\n\n${notes.join("\n")}` : ""}

SIZE LIMIT: the whole summary must stay within about ${budget} tokens (roughly ${budget * 2} Chinese characters or ${budget * 4} Latin characters). It must not grow from one update to the next: when it is near the limit, make room by condensing or deleting older material${previous ? ", including material in the previous summary" : ""}.

Keep, in this order of priority:
1. What the user is asking for now and the state of the work in progress, with the exact file paths, identifiers, commands and error messages still needed to continue.
2. Standing rules and preferences the user stated. They keep applying, so keep them, each stated once.
3. Decisions that still constrain future work, one line each.
4. Finished work: the most recent items one line each, and older finished work merged into a few sentences.

Leave out:
- Lists of files that were read or modified. They are tracked separately and appended automatically.
- Step-by-step history, check counts and verification details of work that is finished.
- Anything a later message superseded.

Write in the language the user writes in. Use this exact format:

## Goal
[What the user is trying to accomplish now]

## Constraints & Preferences
- [Standing requirements from the user]

## Progress
### Done
- [x] [Finished work, recent items first]

### In Progress
- [ ] [Current work and its exact state]

### Blocked
- [Open blockers, or "None"]

## Key Decisions
- **[Decision]**: [Short rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue that fits nowhere above]`;
}

const SHORTER_PLEASE =
  "\n\nYour previous attempt ran past the output limit before finishing. Write a summary of at most half the size limit above: keep the current task and the standing rules, and cut everything else hard.";

interface Reply {
  text: string;
  usage: Usage | undefined;
}

/** One summary request, retried after transient provider errors and once, asking for less, after running out of output. */
async function ask(
  ctx: ExtensionContext,
  model: ChatModel,
  config: Config,
  level: Level,
  prompt: string,
  maxTokens: number,
  signal: AbortSignal,
): Promise<Reply> {
  let usage: Usage | undefined;
  let failures = 0;
  let askedForLess = false;
  for (;;) {
    const options: SimpleStreamOptions = {
      signal,
      maxTokens,
      // One-off prompt: nothing to cache, and a fresh routing ID keeps it off the session's own.
      cacheRetention: "none",
      sessionId: uuidv7(),
    };
    if (level !== "off") options.reasoning = level;
    const message = await ctx.modelRegistry
      .streamSimple(
        model,
        {
          systemPrompt: SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: askedForLess ? prompt + SHORTER_PLEASE : prompt }],
              timestamp: Date.now(),
            },
          ],
        },
        options,
      )
      .result();
    usage = addUsage(usage, message.usage);
    if (signal.aborted || message.stopReason === "aborted") throw new Error("aborted");

    if (message.stopReason === "stop") {
      const text = message.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!text) throw new Error("模型返回了空摘要");
      return { text, usage };
    }
    if (message.stopReason === "length" && !askedForLess) {
      askedForLess = true;
      continue;
    }
    const reason = message.errorMessage || `stopReason=${message.stopReason}`;
    if (message.stopReason !== "error" || !TRANSIENT_ERROR.test(reason) || failures >= config.retries) {
      throw new Error(reason);
    }
    failures++;
    await sleep(Math.min(30_000, 2000 * 2 ** (failures - 1)), signal);
  }
}

export default function (pi: ExtensionAPI) {
  /** For /compact-model completions, which get no context. Refreshed on session start. */
  let knownModels: string[] = [];

  const notify = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error") => {
    if (ctx.hasUI) ctx.ui.notify(text, level);
  };
  const setStatus = (ctx: ExtensionContext, text: string | undefined) => {
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, text);
  };

  pi.on("session_start", (_event, ctx) => {
    knownModels = ctx.modelRegistry.getAvailable().map(modelKey);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const { config, problem } = readConfig();
    if (problem) notify(ctx, `compact-model：${problem}`, "warning");
    if (!config.enabled) return;
    const { model, warning } = pickModel(ctx, config);
    if (warning) notify(ctx, warning, "warning");
    if (!model) return;

    const { preparation, signal } = event;
    const started = Date.now();
    try {
      const level = clampThinkingLevel(model, config.thinkingLevel);
      // Output: room for the summary plus slack, more when thinking shares the allowance,
      // and never more than the model can emit.
      const wanted = Math.max(16_000, config.maxSummaryTokens * 3) * OUTPUT_FACTOR[level];
      const maxOutput = Math.min(model.maxTokens > 0 ? model.maxTokens : FALLBACK_MAX_OUTPUT, wanted);
      const budget = Math.min(config.maxSummaryTokens, Math.floor(maxOutput / (2 * OUTPUT_FACTOR[level])));
      const contextWindow = model.contextWindow > 0 ? model.contextWindow : FALLBACK_CONTEXT_WINDOW;
      const inputBudget = Math.floor((contextWindow - maxOutput) * 0.8) - PROMPT_OVERHEAD;

      // A summary written by Pi can be far over budget. It still has to fit beside the conversation.
      let summary = clip(stripFileLists(preparation.previousSummary ?? ""), Math.floor(inputBudget / 2));
      // Later parts carry the model's own summary instead, which the output cap bounds.
      const chunkBudget = inputBudget - Math.max(estimateTokens(summary), maxOutput);
      if (chunkBudget < 2000) throw new Error(`${modelKey(model)} 的上下文窗口（${contextWindow}）太小，放不下摘要和对话`);

      const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
      const pieces = convertToLlm(messages.map(capToolArguments))
        .map((message) => serializeConversation([message]))
        .filter((piece) => piece.length > 0);
      const chunks = packChunks(pieces, chunkBudget);
      if (chunks.length === 0) throw new Error("没有可以摘要的内容");

      let usage: Usage | undefined;
      for (let i = 0; i < chunks.length; i++) {
        setStatus(ctx, `🗜 ${modelKey(model)} 压缩中${chunks.length > 1 ? ` ${i + 1}/${chunks.length}` : ""}`);
        const prompt = buildPrompt({
          conversation: chunks[i],
          previous: summary,
          budget,
          part: i + 1,
          parts: chunks.length,
          endsMidTurn: preparation.isSplitTurn,
          focus: event.customInstructions,
        });
        const reply = await ask(ctx, model, config, level, prompt, maxOutput, signal);
        summary = stripFileLists(reply.text);
        usage = addUsage(usage, reply.usage);
      }

      const before = previousFiles(event.branchEntries, config);
      const now = touchedFiles(messages);
      const modifiedFiles = newest(before.modified, now.modified, config.maxModifiedFiles);
      const modified = new Set(modifiedFiles);
      const readFiles = newest(
        before.read.filter((path) => !modified.has(path)),
        now.read.filter((path) => !modified.has(path)),
        config.maxReadFiles,
      );

      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      notify(
        ctx,
        `compact-model：${modelKey(model)}${level === "off" ? " " : `（思考 ${level}）`}压缩完成，${seconds}s${chunks.length > 1 ? `（${chunks.length} 次请求）` : ""}，摘要约 ${estimateTokens(summary)} tokens`,
        "info",
      );
      return {
        compaction: {
          summary: summary + formatFileLists(readFiles, modifiedFiles),
          firstKeptEntryId: preparation.firstKeptEntryId,
          tokensBefore: preparation.tokensBefore,
          usage,
          details: {
            by: DETAILS_MARK,
            model: modelKey(model),
            thinkingLevel: level,
            requests: chunks.length,
            readFiles,
            modifiedFiles,
          },
        },
      };
    } catch (error) {
      if (signal.aborted) return { cancel: true };
      const reason = error instanceof Error ? error.message : String(error);
      notify(ctx, `compact-model 未能完成，改用 Pi 内置压缩：${reason}`, "error");
      return;
    } finally {
      setStatus(ctx, undefined);
    }
  });

  /** The level as it will run on `model`, with a note when that differs from the level asked for. */
  const levelOn = (model: ChatModel | undefined, wanted: Level): string => {
    const actual = model ? clampThinkingLevel(model, wanted) : wanted;
    if (!model || actual === wanted) return wanted;
    return `${wanted}（${modelKey(model)} 没有这一档，实际使用 ${actual}）`;
  };

  const describe = (ctx: ExtensionContext): string => {
    const { config, problem } = readConfig();
    const session = ctx.model ? modelKey(ctx.model) : "未选择";
    const lines = [
      `compact-model：${config.enabled ? "已启用" : "已停用（使用 Pi 内置压缩）"}`,
      `模型：${config.model ?? `跟随会话模型（当前 ${session}）`}`,
      `思考等级：${levelOn(pickModel(ctx, config).model, config.thinkingLevel)}`,
      `摘要上限：约 ${config.maxSummaryTokens} tokens`,
      `文件清单上限：修改 ${config.maxModifiedFiles}，只读 ${config.maxReadFiles}`,
      `配置文件：${configPath()}`,
    ];
    if (problem) lines.push(`⚠ ${problem}`);
    return lines.join("\n");
  };

  /** Save a change, or report why it could not be saved. */
  const save = (ctx: ExtensionContext, patch: Partial<Config>, done: string) => {
    try {
      updateConfig(patch);
      notify(ctx, done, "info");
    } catch (error) {
      notify(ctx, `compact-model：${configPath()} 无法写入，设置未保存：${(error as Error).message}`, "error");
    }
  };

  const FOLLOW_SESSION = "跟随会话模型";
  const KEYWORDS = new Set(["status", "session", "thinking", "on", "off"]);
  const CURRENT_MARK = "  ✓ 当前";

  const matching = (filter: string) => knownModels.filter((key) => key.toLowerCase().includes(filter.toLowerCase()));

  /** Show the models to choose from, the current choice marked. Resolves to a command argument, or undefined when dismissed. */
  const pick = async (ctx: ExtensionContext, filter: string): Promise<string | undefined> => {
    const { config } = readConfig();
    const mark = (model: string | null) => (config.model === model ? CURRENT_MARK : "");
    const choices = new Map<string, string>();
    if (!filter) choices.set(FOLLOW_SESSION + mark(null), "session");
    for (const key of matching(filter)) choices.set(key + mark(key), key);
    const title = [
      "压缩上下文用哪个模型？",
      filter ? `（名称含“${filter}”）` : "",
      config.enabled ? "" : "（compact-model 目前已停用，/compact-model on 启用）",
    ].join("");
    const picked = await ctx.ui.select(title, [...choices.keys()]);
    return picked === undefined ? undefined : choices.get(picked);
  };

  /** Show the thinking levels `model` supports, the one in effect marked. Undefined when dismissed or when there is nothing to choose. */
  const pickLevel = async (ctx: ExtensionContext, model: ChatModel | undefined, name: string): Promise<Level | undefined> => {
    const levels = model ? getSupportedThinkingLevels(model) : [...LEVELS];
    if (levels.length < 2) return undefined;
    const { config } = readConfig();
    const current = model ? clampThinkingLevel(model, config.thinkingLevel) : config.thinkingLevel;
    const choices = new Map<string, Level>();
    for (const level of levels) {
      choices.set((level === "off" ? "off（不思考，最快）" : level) + (level === current ? CURRENT_MARK : ""), level);
    }
    const picked = await ctx.ui.select(`${name} 压缩时用哪个思考等级？等级越高，压缩越慢`, [...choices.keys()]);
    return picked === undefined ? undefined : choices.get(picked);
  };

  /** /compact-model thinking [level] */
  const setLevel = async (ctx: ExtensionContext, argument: string) => {
    const { config } = readConfig();
    const model = pickModel(ctx, config).model;
    let level: Level | undefined;
    if (isLevel(argument)) {
      level = argument;
    } else if (argument) {
      notify(ctx, `compact-model：没有“${argument}”这个思考等级，设置未改动。可用：${LEVELS.join(" / ")}`, "error");
      return;
    } else if (!ctx.hasUI) {
      notify(ctx, describe(ctx), "info");
      return;
    } else if (model && getSupportedThinkingLevels(model).length < 2) {
      const only = getSupportedThinkingLevels(model)[0] ?? "off";
      notify(ctx, `compact-model：${modelKey(model)} 的思考等级只有 ${only} 一档，没有可选的。`, "info");
      return;
    } else {
      level = await pickLevel(ctx, model, config.model ?? FOLLOW_SESSION);
      if (level === undefined) return;
    }
    save(ctx, { thinkingLevel: level }, `compact-model：压缩时的思考等级设为 ${levelOn(model, level)}。`);
  };

  pi.registerCommand("compact-model", {
    description:
      "选择压缩上下文用的模型和思考等级：直接回车，从列表里选（也可跟模型名的一部分，或 thinking / status / on / off）",
    getArgumentCompletions: (prefix) => {
      const levels = prefix.startsWith("thinking ") ? LEVELS.map((level) => `thinking ${level}`) : [];
      const items = ["status", "session", "thinking", "on", "off", ...levels, ...knownModels]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      knownModels = ctx.modelRegistry.getAvailable().map(modelKey);
      let choice = args.trim();
      const [keyword, ...rest] = choice.split(/\s+/);
      if (keyword === "thinking") {
        await setLevel(ctx, rest.join(" "));
        return;
      }
      // Anything short of a keyword or an exact model name opens the list, narrowed to what was typed.
      let fromList = false;
      if (ctx.hasUI && !KEYWORDS.has(choice) && !findModel(ctx, choice) && matching(choice).length > 0) {
        const picked = await pick(ctx, choice);
        if (picked === undefined) return;
        choice = picked;
        fromList = true;
      }
      /** Save the model choice. A choice made from the list is followed by the list of its thinking levels. */
      const useModel = async (model: ChatModel | undefined, key: string | null, sentence: string) => {
        const level = fromList ? await pickLevel(ctx, model, key ?? FOLLOW_SESSION) : undefined;
        const patch: Partial<Config> = level === undefined ? { model: key } : { model: key, thinkingLevel: level };
        save(ctx, patch, `compact-model：${sentence}，思考等级 ${levelOn(model, level ?? readConfig().config.thinkingLevel)}。`);
      };
      switch (choice) {
        case "":
        case "status":
          notify(ctx, describe(ctx), "info");
          return;
        case "on":
          save(ctx, { enabled: true }, "compact-model：已启用。");
          return;
        case "off":
          save(ctx, { enabled: false }, "compact-model：已停用，压缩交还 Pi 内置实现。");
          return;
        case "session":
          await useModel(ctx.model, null, "压缩将跟随会话当前的模型");
          return;
      }
      const model = findModel(ctx, choice);
      if (!model) {
        notify(ctx, `compact-model：没有名称含“${choice}”的可用模型，设置未改动。直接运行 /compact-model 可以从列表里选。`, "error");
        return;
      }
      if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
        notify(ctx, `compact-model：模型 ${choice} 没有可用凭据。设置未改动。`, "error");
        return;
      }
      await useModel(model, modelKey(model), `今后用 ${modelKey(model)} 压缩上下文`);
    },
  });
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiscoveredSession } from "../discovery/sessions.js";
import type { PickerPage } from "../session/picker.js";
import type { SessionRecord } from "../types.js";
import type { CommandContext } from "./context.js";

vi.mock("../discovery/sessions.js", () => ({ discoverSessions: vi.fn() }));

import { execFileSync } from "node:child_process";
import * as configModule from "../config.js";
import { discoverSessions } from "../discovery/sessions.js";
import {
  cmdFile,
  cmdKill,
  cmdMac,
  cmdNew,
  cmdDiscard,
  cmdRepo,
  cmdScreen,
  cmdSessions,
  cmdStop,
  cmdUsage,
  cmdVerbose,
} from "./handlers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const JID = "handlers-test-jid";

beforeEach(() => {
  vi.spyOn(configModule, "config", "get").mockReturnValue({ ...configModule.config, projectSearchRoots: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeSession(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    jid: JID,
    workingDir: os.tmpdir(),
    engine: "claude",
    model: null,
    effort: null,
    state: "IDLE",
    ptyPid: null,
    waitingSince: null,
    tmuxSession: "wa-claude-current",
    resumeId: "current-resume-id",
    title: null,
    started: true,
    verbose: false,
    resolvedModel: null,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakePicker<T>(sink: { jid: string; list: T[] }[]) {
  const renders = new Map<string, () => string>();
  const show = vi.fn((jid: string, list: T[], render: (page: PickerPage<T>) => string) => {
    sink.push({ jid, list });
    renders.set(jid, () => render({ items: list, startNumber: 1, more: null, totalCount: list.length }));
  });
  const renderPage = vi.fn((jid: string) => renders.get(jid)?.() ?? null);
  return { show, renderPage };
}

function fakeCtx() {
  const sentTexts: string[] = [];
  const sentDocuments: string[] = [];
  const updates: Partial<SessionRecord>[] = [];
  const shown: { jid: string; list: DiscoveredSession[] }[] = [];
  const filesShown: { jid: string; list: string[] }[] = [];
  const reposShown: { jid: string; list: string[] }[] = [];
  const ctx = {
    sessionRepo: { update: vi.fn((_jid: string, patch: Partial<SessionRecord>) => updates.push(patch)) },
    ptyManager: {
      isAlive: vi.fn(() => false),
      detach: vi.fn(),
      kill: vi.fn(),
      interrupt: vi.fn(),
      cancelPendingInitial: vi.fn(() => false),
    },
    sender: {
      sendText: vi.fn(async (_jid: string, text: string) => sentTexts.push(text)),
      sendDocument: vi.fn(async (_jid: string, filePath: string) => sentDocuments.push(filePath)),
    },
    sessionPicker: fakePicker(shown),
    filePicker: fakePicker(filesShown),
    repoPicker: fakePicker(reposShown),
    logger: { warn: vi.fn(), info: vi.fn() },
  } as unknown as CommandContext;
  return { ctx, sentTexts, sentDocuments, updates, shown, filesShown, reposShown };
}

describe("cmdNew", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmdnew-test-"));
    vi.spyOn(configModule, "config", "get").mockReturnValue({ ...configModule.config, workspacesRoot: dir });
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("recognizes a Codex model without creating a model-named directory", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession({ workingDir: dir }), "codex gpt-example");
    expect(updates[0]).toMatchObject({ engine: "codex", model: "gpt-example", workingDir: dir });
  });

  it("accepts explicit custom models and quoted paths containing spaces", async () => {
    const target = path.join(dir, "project with spaces");
    fs.mkdirSync(target);
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession(), `codex --model custom-model "${target}"`);
    expect(updates[0]).toMatchObject({ engine: "codex", model: "custom-model", workingDir: target });
  });

  it("does not interpret an explicit model name as an engine selector", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession({ workingDir: dir }), "--model codex");
    expect(updates[0]).toMatchObject({ engine: "claude", model: "codex", workingDir: dir });
  });

  it("clears engine-specific settings when switching engines", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession({ workingDir: dir, model: "opus", effort: "high" }), "codex");
    expect(updates[0]).toMatchObject({ engine: "codex", model: null, effort: null });
  });

  it.each(['"unclosed', "--model", "--unknown", "claude opencode", "sonnet opus"])(
    "rejects malformed arguments (%s) without changing sessions",
    async (args) => {
      const { ctx, sentTexts, updates } = fakeCtx();
      await cmdNew(ctx, JID, fakeSession(), args);
      expect(sentTexts[0]).toContain("❌");
      expect(updates).toEqual([]);
    },
  );

  it("picks up engine, model and path tokens in any order", async () => {
    const { ctx, sentTexts, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession(), `opus ${dir} opencode`);

    expect(updates[0]).toMatchObject({ engine: "opencode", model: "opus", workingDir: dir, state: "IDLE" });
    expect(sentTexts[0]).toContain(dir);
    expect(sentTexts[0]).toContain("opencode");
  });

  it("defaults to the current session's engine, model and directory when no args are given", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession({ engine: "opencode", model: "sonnet", workingDir: dir }), "");
    expect(updates[0]).toMatchObject({ engine: "opencode", model: "sonnet", workingDir: dir });
  });

  it("rejects a directory whose parent doesn't exist either, without touching the session", async () => {
    const { ctx, sentTexts, updates } = fakeCtx();
    const missing = path.join(dir, "no-such-parent", "does-not-exist");
    await cmdNew(ctx, JID, fakeSession(), missing);

    expect(sentTexts[0]).toContain("not found");
    expect(updates).toHaveLength(0);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it("creates a new project folder when only its parent exists", async () => {
    const { ctx, sentTexts, updates } = fakeCtx();
    const fresh = path.join(dir, "brand-new-project");
    await cmdNew(ctx, JID, fakeSession(), fresh);

    expect(fs.statSync(fresh).isDirectory()).toBe(true);
    expect(sentTexts[0]).toContain("Directory created");
    expect(updates[0]).toMatchObject({ workingDir: fresh });
  });

  it("detaches (not kills) a currently-alive session instead of destroying it", async () => {
    const { ctx } = fakeCtx();
    (ctx.ptyManager.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await cmdNew(ctx, JID, fakeSession(), dir);

    expect(ctx.ptyManager.detach).toHaveBeenCalledWith(JID);
    expect(ctx.ptyManager.kill).not.toHaveBeenCalled();
  });

  it("mints a fresh resumeId and tmux session name distinct from the current one", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession({ tmuxSession: "wa-claude-old" }), dir);
    expect(updates[0]!.tmuxSession).not.toBe("wa-claude-old");
    expect(updates[0]!.resumeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(updates[0]!.tmuxSession).toBe(`wa-claude-${updates[0]!.resumeId}`);
    expect(updates[0]!.started).toBe(false);
  });

  it("recognizes an effort-level token (low/medium/high/xhigh/max) instead of folding it into the model string", async () => {
    const { ctx, updates, sentTexts } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession(), `claude sonnet high ${dir}`);

    expect(updates[0]).toMatchObject({ engine: "claude", model: "sonnet", effort: "high", workingDir: dir });
    expect(sentTexts[0]).toContain("sonnet");
    expect(sentTexts[0]).toContain("effort high");
  });

  it("is case-insensitive for the effort token, same as engine names", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession(), `HIGH ${dir}`);
    expect(updates[0]).toMatchObject({ effort: "high", model: null });
  });

  it("keeps the current session's effort when /new is given no effort token", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession({ effort: "low" }), dir);
    expect(updates[0]).toMatchObject({ effort: "low" });
  });

  it("maps 'extra' to the real 'xhigh' flag value instead of folding it into the model string", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession({ effort: "high" }), `extra ${dir}`);
    expect(updates[0]).toMatchObject({ effort: "xhigh", model: null });
  });

  it("also maps 'extrahigh' to 'xhigh'", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdNew(ctx, JID, fakeSession({ effort: "high" }), `extrahigh ${dir}`);
    expect(updates[0]).toMatchObject({ effort: "xhigh" });
  });

  describe("single-word repo matching (avoids typing a full path)", () => {
    function makeNamedDir(name: string): string {
      const target = path.join(dir, name);
      fs.mkdirSync(target);
      return target;
    }

    function fakeDirs(dirs: string[]): DiscoveredSession[] {
      return dirs.map((directory, i) => ({
        engine: "claude",
        resumeId: `r${i}`,
        directory,
        title: "t",
        updatedAt: Date.now() - i,
        live: false,
        tmuxSession: `wa-claude-r${i}`,
        activeElsewhere: false,
      }));
    }

    it("resolves a bare word to a known directory by its exact basename, instead of treating it as a model name", async () => {
      const sampleProject = makeNamedDir("sampleProject");
      const blog = makeNamedDir("blog");
      (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(fakeDirs([sampleProject, blog]));
      const { ctx, updates } = fakeCtx();
      await cmdNew(ctx, JID, fakeSession(), "sampleProject");

      expect(updates[0]).toMatchObject({ workingDir: sampleProject, model: null });
    });

    it("is case-insensitive for the basename match", async () => {
      const sampleProject = makeNamedDir("sampleProject");
      (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(fakeDirs([sampleProject]));
      const { ctx, updates } = fakeCtx();
      await cmdNew(ctx, JID, fakeSession(), "SAMPLEPROJECT");
      expect(updates[0]).toMatchObject({ workingDir: sampleProject });
    });

    it("falls back to a single substring match when there's no exact basename match", async () => {
      const cliBridge = makeNamedDir("sample-app");
      const other = makeNamedDir("other");
      (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(fakeDirs([cliBridge, other]));
      const { ctx, updates } = fakeCtx();
      await cmdNew(ctx, JID, fakeSession(), "sample");
      expect(updates[0]).toMatchObject({ workingDir: cliBridge });
    });

    it("never guesses between two or more ambiguous matches — asks to be more precise instead", async () => {
      makeNamedDir("sample-app");
      makeNamedDir("sample-tests");
      (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(
        fakeDirs([path.join(dir, "sample-app"), path.join(dir, "sample-tests")]),
      );
      const currentDir = makeNamedDir("current");
      const { ctx, updates, sentTexts } = fakeCtx();
      await cmdNew(ctx, JID, fakeSession({ workingDir: currentDir }), "sample");

      expect(updates).toHaveLength(0);
      expect(sentTexts[0]).toContain("Several directories");
      expect(sentTexts[0]).toContain("sample-app");
    });

    it("still falls back to the model-name path when the word matches no known directory at all", async () => {
      const blog = makeNamedDir("blog");
      (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(fakeDirs([blog]));
      const { ctx, updates } = fakeCtx();
      await cmdNew(ctx, JID, fakeSession(), "sonnet");
      expect(updates[0]).toMatchObject({ model: "sonnet" });
    });
  });

  describe("disk-search fallback", () => {
    let searchRoot: string;

    beforeEach(() => {
      searchRoot = fs.mkdtempSync(path.join(dir, "search-root-"));
      vi.spyOn(configModule, "config", "get").mockReturnValue({
        ...configModule.config,
        projectSearchRoots: [searchRoot],
        workspacesRoot: dir,
      });
      (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    });

    it("uses an existing project found on disk instead of creating an empty decoy under workspacesRoot", async () => {
      const sampleProject = path.join(searchRoot, "sample-project");
      fs.mkdirSync(sampleProject);
      fs.writeFileSync(path.join(sampleProject, "notes.md"), "real content");

      const { ctx, updates, sentTexts } = fakeCtx();
      await cmdNew(ctx, JID, fakeSession(), "sample-project");

      expect(updates[0]).toMatchObject({ workingDir: sampleProject });
      expect(sentTexts[0]).not.toContain("Directory created");
      expect(fs.existsSync(path.join(dir, "sample-project"))).toBe(false);
    });

    it("still asks to disambiguate when the name matches more than one folder on disk", async () => {
      const rootA = fs.mkdtempSync(path.join(dir, "root-a-"));
      const rootB = fs.mkdtempSync(path.join(dir, "root-b-"));
      fs.mkdirSync(path.join(rootA, "sample-project"));
      fs.mkdirSync(path.join(rootB, "sample-project"));
      vi.spyOn(configModule, "config", "get").mockReturnValue({
        ...configModule.config,
        projectSearchRoots: [rootA, rootB],
        workspacesRoot: dir,
      });

      const { ctx, updates, sentTexts } = fakeCtx();
      await cmdNew(ctx, JID, fakeSession(), "sample-project");

      expect(updates).toHaveLength(0);
      expect(sentTexts[0]).toContain("Several directories");
    });

    it("still creates a brand-new project under workspacesRoot when nothing matches on disk either", async () => {
      const { ctx, updates, sentTexts } = fakeCtx();
      await cmdNew(ctx, JID, fakeSession(), "genuinely-new-project");

      expect(sentTexts[0]).toContain("Directory created");
      expect(updates[0]).toMatchObject({ workingDir: path.join(dir, "genuinely-new-project") });
    });
  });
});

describe("cmdRepo", () => {
  function fakeDirs(dirs: string[]): DiscoveredSession[] {
    return dirs.map((directory, i) => ({
      engine: "claude",
      resumeId: `r${i}`,
      directory,
      title: "t",
      updatedAt: Date.now() - i,
      live: false,
      tmuxSession: `wa-claude-r${i}`,
      activeElsewhere: false,
    }));
  }

  it("lists every known directory, deduplicated, as a numbered picker", async () => {
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(
      fakeDirs(["/Users/example/blog", "/Users/example/blog", "/Users/example/api"]),
    );
    const { ctx, sentTexts, reposShown } = fakeCtx();
    await cmdRepo(ctx, JID, fakeSession(), "");

    expect(reposShown[0]!.list).toEqual(["/Users/example/blog", "/Users/example/api"]);
    expect(sentTexts[0]).toContain("1.");
    expect(sentTexts[0]).toContain("2.");
    expect(sentTexts[0]).toContain("Reply with a number");
  });

  it("filters by the same substring matching /sessions already uses", async () => {
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(
      fakeDirs(["/Users/example/blog", "/Users/example/api"]),
    );
    const { ctx, reposShown } = fakeCtx();
    await cmdRepo(ctx, JID, fakeSession(), "api");

    expect(reposShown[0]!.list).toEqual(["/Users/example/api"]);
  });

  it("reports no match instead of an empty picker", async () => {
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(fakeDirs(["/Users/example/blog"]));
    const { ctx, sentTexts, reposShown } = fakeCtx();
    await cmdRepo(ctx, JID, fakeSession(), "no-such-project");

    expect(reposShown).toHaveLength(0);
    expect(sentTexts[0]).toContain("No directory");
  });

  it("also offers a project sitting on disk that was never opened via Claude Code/OpenCode before", async () => {
    const searchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cmdrepo-search-root-"));
    const sampleProject = path.join(searchRoot, "sample-project");
    fs.mkdirSync(sampleProject);
    vi.spyOn(configModule, "config", "get").mockReturnValue({
      ...configModule.config,
      projectSearchRoots: [searchRoot],
    });
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(fakeDirs(["/Users/example/blog"]));

    const { ctx, reposShown } = fakeCtx();
    await cmdRepo(ctx, JID, fakeSession(), "sample-project");

    expect(reposShown[0]!.list).toEqual([sampleProject]);
    fs.rmSync(searchRoot, { recursive: true, force: true });
  });
});

describe("cmdSessions", () => {
  function fakeList(): DiscoveredSession[] {
    return [
      {
        engine: "claude",
        resumeId: "a",
        directory: "/Users/example/blog",
        title: "Fix footer",
        updatedAt: Date.now(),
        live: true,
        tmuxSession: "wa-claude-a",
        activeElsewhere: false,
      },
      {
        engine: "opencode",
        resumeId: "b",
        directory: "/Users/example/api",
        title: "Add endpoint",
        updatedAt: Date.now() - 60_000,
        live: false,
        tmuxSession: "wa-opencode-b",
        activeElsewhere: false,
      },
    ];
  }

  it("reports when nothing is discovered", async () => {
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue([]);
    const { ctx, sentTexts } = fakeCtx();
    await cmdSessions(ctx, JID, fakeSession(), "");
    expect(sentTexts[0]).toContain("No sessions");
  });

  it("shows the list to the picker, grouped by project, and marks live vs. current vs. idle", async () => {
    const list = fakeList();
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(list);
    const { ctx, sentTexts, shown } = fakeCtx();
    await cmdSessions(ctx, JID, fakeSession({ tmuxSession: "wa-opencode-b" }), "");

    expect(shown[0]).toMatchObject({ jid: JID, list });
    const output = sentTexts[0]!;
    expect(output).toMatch(/\*blog\*\n1\. 🟢 \[claude\] Fix footer/);
    expect(output).toMatch(/\*api\*\n2\. ❯ \[opencode\] Add endpoint/);
  });

  it("groups a worktree checkout under its project name, not the opaque slug", async () => {
    const list = fakeList();
    list[0]!.directory = "/Users/example/sample-app/.claude/worktrees/feature-worktree";
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(list);
    const { ctx, sentTexts } = fakeCtx();
    await cmdSessions(ctx, JID, fakeSession(), "");

    expect(sentTexts[0]).toContain("*sample-app / feature-worktree*");
  });

  it("marks a session open elsewhere with a warning icon and a hint line", async () => {
    const list = fakeList();
    list[0]!.activeElsewhere = true;
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(list);
    const { ctx, sentTexts } = fakeCtx();
    await cmdSessions(ctx, JID, fakeSession({ tmuxSession: "wa-opencode-b" }), "");

    const output = sentTexts[0]!;
    expect(output).toMatch(/1\. ⚠️ \[claude\] Fix footer/);
    expect(output).toContain("already open elsewhere");
  });

  it("filters by title or directory substring", async () => {
    const list = fakeList();
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(list);
    const { ctx, sentTexts } = fakeCtx();
    await cmdSessions(ctx, JID, fakeSession(), "footer");

    const output = sentTexts[0]!;
    expect(output).toContain("Fix footer");
    expect(output).not.toContain("Add endpoint");
  });

  it("reports no match for a filter that hits nothing", async () => {
    (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(fakeList());
    const { ctx, sentTexts } = fakeCtx();
    await cmdSessions(ctx, JID, fakeSession(), "no-such-thing-xyz");
    expect(sentTexts[0]).toContain("No session matches");
  });

  describe("hiding old/tiny sessions by default", () => {
    function fakeListWithOldAndTiny(): DiscoveredSession[] {
      return [
        {
          engine: "claude",
          resumeId: "recent",
          directory: "/Users/example/blog",
          title: "Recent, real conversation",
          updatedAt: Date.now(),
          live: false,
          tmuxSession: "wa-claude-recent",
          activeElsewhere: false,
          sizeBytes: 50_000,
        },
        {
          engine: "claude",
          resumeId: "old",
          directory: "/Users/example/blog",
          title: "Ancient conversation",
          updatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000, // 10 days ago
          live: false,
          tmuxSession: "wa-claude-old",
          activeElsewhere: false,
          sizeBytes: 50_000,
        },
        {
          engine: "claude",
          resumeId: "tiny",
          directory: "/private/tmp/scratch",
          title: "Three messages",
          updatedAt: Date.now(),
          live: false,
          tmuxSession: "wa-claude-tiny",
          activeElsewhere: false,
          sizeBytes: 100,
        },
      ];
    }

    it("hides sessions older than 7 days and tiny ones by default", async () => {
      (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(fakeListWithOldAndTiny());
      const { ctx, sentTexts } = fakeCtx();
      await cmdSessions(ctx, JID, fakeSession(), "");

      const output = sentTexts[0]!;
      expect(output).toContain("Recent, real conversation");
      expect(output).not.toContain("Ancient conversation");
      expect(output).not.toContain("Three messages");
      expect(output).toContain("--all");
    });

    it("shows everything with --all", async () => {
      (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(fakeListWithOldAndTiny());
      const { ctx, sentTexts } = fakeCtx();
      await cmdSessions(ctx, JID, fakeSession(), "--all");

      const output = sentTexts[0]!;
      expect(output).toContain("Ancient conversation");
      expect(output).toContain("Three messages");
    });

    it("never hides a currently-live session even if old/tiny", async () => {
      const list = fakeListWithOldAndTiny();
      list[1]!.live = true;
      (discoverSessions as ReturnType<typeof vi.fn>).mockReturnValue(list);
      const { ctx, sentTexts } = fakeCtx();
      await cmdSessions(ctx, JID, fakeSession(), "");

      expect(sentTexts[0]).toContain("Ancient conversation");
    });
  });
});

describe("cmdFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmdfile-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("sends the file directly when the query matches exactly one", async () => {
    fs.writeFileSync(path.join(dir, "report.md"), "x");
    const { ctx, sentDocuments } = fakeCtx();

    await cmdFile(ctx, JID, fakeSession({ workingDir: dir }), "report");

    expect(sentDocuments).toEqual([path.join(dir, "report.md")]);
  });

  it("shows a numbered list to the file picker when several files match", async () => {
    fs.writeFileSync(path.join(dir, "report.md"), "x");
    fs.writeFileSync(path.join(dir, "report-draft.md"), "x");
    const { ctx, sentTexts, filesShown } = fakeCtx();

    await cmdFile(ctx, JID, fakeSession({ workingDir: dir }), "report");

    expect(filesShown[0]!.list).toHaveLength(2);
    expect(sentTexts[0]).toContain("Reply with a number");
  });

  it("reports when nothing matches", async () => {
    const { ctx, sentTexts } = fakeCtx();
    await cmdFile(ctx, JID, fakeSession({ workingDir: dir }), "does-not-exist");
    expect(sentTexts[0]).toContain("No file");
  });

  it("lists everything (no auto-send) for a bare /file with no query", async () => {
    fs.writeFileSync(path.join(dir, "only.md"), "x");
    const { ctx, sentDocuments, filesShown } = fakeCtx();

    await cmdFile(ctx, JID, fakeSession({ workingDir: dir }), "");

    expect(sentDocuments).toEqual([]);
    expect(filesShown[0]!.list).toEqual([path.join(dir, "only.md")]);
  });
});

describe("cmdVerbose", () => {
  it("toggles off when currently on, with no argument", async () => {
    const { ctx, sentTexts, updates } = fakeCtx();
    await cmdVerbose(ctx, JID, fakeSession({ verbose: true }), "");
    expect(updates[0]).toMatchObject({ verbose: false });
    expect(sentTexts[0]).toContain("disabled");
  });

  it("toggles on when currently off, with no argument", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdVerbose(ctx, JID, fakeSession({ verbose: false }), "");
    expect(updates[0]).toMatchObject({ verbose: true });
  });

  it("sets explicitly with on/off regardless of current state", async () => {
    const { ctx, updates } = fakeCtx();
    await cmdVerbose(ctx, JID, fakeSession({ verbose: true }), "off");
    expect(updates[0]).toMatchObject({ verbose: false });

    const { ctx: ctx2, updates: updates2 } = fakeCtx();
    await cmdVerbose(ctx2, JID, fakeSession({ verbose: false }), "on");
    expect(updates2[0]).toMatchObject({ verbose: true });
  });
});

describe("cmdUsage", () => {
  let binDir: string;
  let originalPath: string;

  beforeEach(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmdusage-test-bin-"));
    const fixture = path.join(__dirname, "__fixtures__", "fake-claude-usage.mjs");
    const shim = path.join(binDir, "claude");
    fs.copyFileSync(fixture, shim);
    fs.chmodSync(shim, 0o755);

    originalPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  });

  it("sends just the session/week summary in a single reply, stripped of timezone and '(all models)' noise", async () => {
    const { ctx, sentTexts } = fakeCtx();
    await cmdUsage(ctx, JID, fakeSession(), "");

    expect(sentTexts).toHaveLength(1);
    const result = sentTexts[0]!;
    expect(result).toContain("Current session: 25% used · resets Jan 1 at 12pm");
    expect(result).toContain("Current week: 50% used · resets Jan 2 at 12pm");
    expect(result).not.toContain("all models");
    expect(result).not.toContain("UTC");
    expect(result).not.toContain("contributing to your limits");
  });

  it("reports an error instead of throwing when the claude binary can't be found", async () => {
    fs.rmSync(path.join(binDir, "claude"));
    process.env.PATH = binDir;
    const { ctx, sentTexts } = fakeCtx();
    await cmdUsage(ctx, JID, fakeSession(), "");

    expect(sentTexts[0]).toContain("Could not retrieve usage");
  });
});

describe("cmdUsage — opencode/DeepSeek balance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports the DeepSeek balance for an opencode session on a deepseek/* model", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ deepseek: { type: "api", key: "sk-test-key" } }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "0.47" }] }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { ctx, sentTexts } = fakeCtx();
    await cmdUsage(ctx, JID, fakeSession({ engine: "opencode", model: "deepseek/deepseek-v4-pro" }), "");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.deepseek.com/user/balance",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sk-test-key" }) }),
    );
    expect(sentTexts[0]).toContain("0.47 USD");
  });

  it("flags an exhausted account instead of just printing 0", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ deepseek: { type: "api", key: "sk-test-key" } }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ is_available: false, balance_infos: [{ currency: "USD", total_balance: "0.00" }] }),
      })),
    );

    const { ctx, sentTexts } = fakeCtx();
    await cmdUsage(ctx, JID, fakeSession({ engine: "opencode", model: "deepseek/deepseek-v4-pro" }), "");

    expect(sentTexts[0]).toContain("account depleted");
  });

  it("says the provider isn't supported for a non-DeepSeek opencode model, instead of guessing", async () => {
    const { ctx, sentTexts } = fakeCtx();
    await cmdUsage(ctx, JID, fakeSession({ engine: "opencode", model: "openai/gpt-5" }), "");

    expect(sentTexts[0]).toContain("openai");
    expect(sentTexts[0]).toContain("Usage is unavailable");
  });

  it("reports an error instead of throwing when no DeepSeek key is configured", async () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });

    const { ctx, sentTexts } = fakeCtx();
    await cmdUsage(ctx, JID, fakeSession({ engine: "opencode", model: "deepseek/deepseek-v4-pro" }), "");

    expect(sentTexts[0]).toContain("Could not retrieve DeepSeek balance");
  });

  it("reports an error instead of throwing when DeepSeek's API itself errors", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ deepseek: { type: "api", key: "sk-test-key" } }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })),
    );

    const { ctx, sentTexts } = fakeCtx();
    await cmdUsage(ctx, JID, fakeSession({ engine: "opencode", model: "deepseek/deepseek-v4-pro" }), "");

    expect(sentTexts[0]).toContain("Could not retrieve DeepSeek balance");
  });
});

describe("cmdStop", () => {
  it("sends Escape into a live session", async () => {
    const { ctx, sentTexts } = fakeCtx();
    (ctx.ptyManager.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await cmdStop(ctx, JID, fakeSession(), "");
    expect(ctx.ptyManager.interrupt).toHaveBeenCalledWith(JID);
    expect(sentTexts[0]).toContain("Interrupt");
  });

  it("is a no-op message when nothing is running", async () => {
    const { ctx, sentTexts } = fakeCtx();
    await cmdStop(ctx, JID, fakeSession(), "");
    expect(ctx.ptyManager.interrupt).not.toHaveBeenCalled();
    expect(sentTexts[0]).toContain("Nothing is running");
  });
});

describe("cmdScreen", () => {
  const SESSION = "wa-claude-handlers-test-screen";

  afterEach(() => {
    try {
      execFileSync("tmux", ["kill-session", "-t", SESSION], { stdio: "ignore" });
    } catch {
      // already gone
    }
  });

  it("sends the raw tmux pane content in a code block", async () => {
    execFileSync("tmux", [
      "-u",
      "new-session",
      "-d",
      "-s",
      SESSION,
      "-x",
      "80",
      "-y",
      "24",
      "--",
      "node",
      "-e",
      "process.stdout.write('raw screen content'); setInterval(() => {}, 1000)",
    ]);
    await new Promise((r) => setTimeout(r, 500));

    const { ctx, sentTexts } = fakeCtx();
    await cmdScreen(ctx, JID, fakeSession({ tmuxSession: SESSION }), "");

    expect(sentTexts[0]).toContain("raw screen content");
    expect(sentTexts[0]).toMatch(/```/);
  });

  it("says nothing is running when the tmux session doesn't exist", async () => {
    const { ctx, sentTexts } = fakeCtx();
    await cmdScreen(ctx, JID, fakeSession({ tmuxSession: "wa-claude-no-such-session-xyz" }), "");
    expect(sentTexts[0]).toContain("Nothing is running");
  });
});

describe("cmdDiscard", () => {
  it("confirms cancellation when something was queued", async () => {
    const { ctx, sentTexts } = fakeCtx();
    (ctx.ptyManager.cancelPendingInitial as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await cmdDiscard(ctx, JID, fakeSession(), "");
    expect(ctx.ptyManager.cancelPendingInitial).toHaveBeenCalledWith(JID);
    expect(sentTexts[0]).toContain("discarded");
  });

  it("says nothing was queued otherwise", async () => {
    const { ctx, sentTexts } = fakeCtx();
    await cmdDiscard(ctx, JID, fakeSession(), "");
    expect(sentTexts[0]).toContain("No message was queued");
  });
});

describe("cmdMac", () => {
  it("sends the exact tmux attach command for the current session", async () => {
    const { ctx, sentTexts } = fakeCtx();
    (ctx.ptyManager.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await cmdMac(ctx, JID, fakeSession({ tmuxSession: "wa-claude-abc123" }), "");

    expect(sentTexts[0]).toContain("tmux attach -t wa-claude-abc123");
  });

  it("tells the user nothing is running rather than sending a dead command", async () => {
    const { ctx, sentTexts } = fakeCtx();
    await cmdMac(ctx, JID, fakeSession(), "");
    expect(sentTexts[0]).toContain("Nothing is running");
  });
});

describe("cmdKill", () => {
  it("kills a live session and resets state", async () => {
    const { ctx, sentTexts, updates } = fakeCtx();
    (ctx.ptyManager.isAlive as ReturnType<typeof vi.fn>).mockReturnValue(true);
    await cmdKill(ctx, JID, fakeSession(), "");
    expect(ctx.ptyManager.kill).toHaveBeenCalledWith(JID);
    expect(updates[0]).toMatchObject({ state: "IDLE", ptyPid: null });
    expect(sentTexts[0]).toContain("stopped");
  });

  it("says nothing was running when there's no live session", async () => {
    const { ctx, sentTexts } = fakeCtx();
    await cmdKill(ctx, JID, fakeSession(), "");
    expect(ctx.ptyManager.kill).not.toHaveBeenCalled();
    expect(sentTexts[0]).toContain("Nothing was running");
  });
});

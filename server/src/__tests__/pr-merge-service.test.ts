import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commentOnPullRequest, mergePullRequest } from "../services/pr-merge.ts";

const mockResolveSecretValue = vi.hoisted(() => vi.fn());

vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(() => ({
    resolveSecretValue: mockResolveSecretValue,
  })),
}));

type FetchCall = { url: string; init: RequestInit | undefined };

function createDbStub(secretLookupResults: unknown[][]) {
  const pending = [...secretLookupResults];
  const selectWhere = vi.fn(async () => pending.shift() ?? []);
  const from = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as any };
}

describe("mergePullRequest", () => {
  let fetchCalls: FetchCall[] = [];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchCalls = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ merged: true, sha: "abc123", message: "Pull Request successfully merged" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    mockResolveSecretValue.mockResolvedValue("ghp_fake_token_for_tests");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("calls GitHub merge API with the right URL, method, and auth header", async () => {
    const { db } = createDbStub([[{ id: "secret-1" }]]);
    const result = await mergePullRequest(db, "company-1", {
      owner: "Lobbi-Group",
      repo: "lobbi",
      prNumber: 42,
      mergeMethod: "squash",
    });

    expect(result.merged).toBe(true);
    expect(result.sha).toBe("abc123");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe("https://api.github.com/repos/Lobbi-Group/lobbi/pulls/42/merge");
    expect(fetchCalls[0]!.init?.method).toBe("PUT");
    const headers = fetchCalls[0]!.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("token ghp_fake_token_for_tests");
    expect(headers.Accept).toBe("application/vnd.github+json");
    const bodyText = typeof fetchCalls[0]!.init?.body === "string" ? fetchCalls[0]!.init!.body : "";
    expect(JSON.parse(bodyText)).toEqual({ merge_method: "squash" });
  });

  it("defaults to squash merge when no method specified", async () => {
    const { db } = createDbStub([[{ id: "secret-1" }]]);
    await mergePullRequest(db, "company-1", {
      owner: "Lobbi-Group",
      repo: "lobbi",
      prNumber: 1,
    });
    const body = JSON.parse(String(fetchCalls[0]!.init!.body));
    expect(body.merge_method).toBe("squash");
  });

  it("returns merged=false with message when no github_token secret exists", async () => {
    const { db } = createDbStub([[]]);
    const result = await mergePullRequest(db, "company-1", {
      owner: "Lobbi-Group",
      repo: "lobbi",
      prNumber: 42,
    });
    expect(result.merged).toBe(false);
    expect(result.message).toContain("github_token");
    expect(fetchCalls).toHaveLength(0);
  });

  it("returns merged=false with GitHub error when API returns non-2xx", async () => {
    fetchSpy.mockImplementationOnce(async () =>
      new Response(
        JSON.stringify({ message: "Pull Request is not mergeable" }),
        { status: 405, headers: { "Content-Type": "application/json" } },
      ),
    );
    const { db } = createDbStub([[{ id: "secret-1" }]]);
    const result = await mergePullRequest(db, "company-1", {
      owner: "Lobbi-Group",
      repo: "lobbi",
      prNumber: 42,
    });
    expect(result.merged).toBe(false);
    expect(result.statusCode).toBe(405);
    expect(result.message).toContain("not mergeable");
  });

  it("rejects malformed payload without calling fetch", async () => {
    const { db } = createDbStub([]);
    const result = await mergePullRequest(db, "company-1", { owner: "Lobbi-Group" });
    expect(result.merged).toBe(false);
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("commentOnPullRequest", () => {
  let fetchCalls: FetchCall[] = [];
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchCalls = [];
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 1 }), { status: 201 });
    });
    mockResolveSecretValue.mockResolvedValue("ghp_fake_token_for_tests");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("POSTs the comment body to the GitHub issues-comments endpoint", async () => {
    const { db } = createDbStub([[{ id: "secret-1" }]]);
    const result = await commentOnPullRequest(
      db,
      "company-1",
      { owner: "Lobbi-Group", repo: "lobbi", prNumber: 42 },
      "Merge rejected: please split into two PRs.",
    );

    expect(result.posted).toBe(true);
    expect(fetchCalls[0]!.url).toBe(
      "https://api.github.com/repos/Lobbi-Group/lobbi/issues/42/comments",
    );
    expect(fetchCalls[0]!.init?.method).toBe("POST");
    const body = JSON.parse(String(fetchCalls[0]!.init?.body ?? "{}"));
    expect(body.body).toContain("Merge rejected");
  });
});

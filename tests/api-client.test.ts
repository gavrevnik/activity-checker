import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../src/api";
import { saveEntityState, savePersonalState } from "../src/entity-state-api";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const card = {
  id: "a",
  reaction: "dislike",
  favorite: false,
  updatedAt: "saved",
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });

describe("API responses and safe reaction recovery", () => {
  it("does not falsely confirm feedback by reaction alone after a lost response", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(json({ ...card, dislikeReason: "Old reason" }))
      .mockResolvedValueOnce(json({ ...card, dislikeReason: "Too late" }));
    vi.stubGlobal("fetch", fetch);
    const assertion = expect(
      saveEntityState("a", { dislikeReason: "Too late" }),
    ).resolves.toMatchObject({ dislikeReason: "Too late" });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const call of [fetch.mock.calls[0], fetch.mock.calls[2]])
      expect(JSON.parse(call[1].body)).toEqual({ dislikeReason: "Too late" });
  });
  it("saves Telegram personal state to its separate endpoint and confirms lost responses", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(json({ ...card, favorite: true }));
    vi.stubGlobal("fetch", fetch);
    const assertion = expect(
      savePersonalState("/telegram-events", "a", { favorite: true }),
    ).resolves.toMatchObject({ favorite: true });
    await vi.runAllTimersAsync();
    await assertion;
    expect(
      fetch.mock.calls.map(([path, options]) => [path, options.method]),
    ).toEqual([
      ["/api/telegram-events/a", "PATCH"],
      ["/api/telegram-events/a", "GET"],
    ]);
  });
  it("reports an empty proxy response without exposing a JSON parser exception", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 502 })),
    );
    await expect(
      api("/entities/a", "PATCH", { reaction: "dislike" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 502,
      retryable: true,
      message: expect.stringContaining("HTTP 502"),
    });
  });
  it("preserves JSON validation errors and handles non-JSON HTTP failures", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: "Оценивать можно только мероприятия" }, 400),
      )
      .mockResolvedValueOnce(
        new Response("<html><svg>Proxy failed</svg></html>", { status: 503 }),
      );
    vi.stubGlobal("fetch", fetch);
    await expect(api("/entities/a", "PATCH", {})).rejects.toThrow(
      "Оценивать можно только мероприятия",
    );
    await expect(api("/entities/a", "PATCH", {})).rejects.toThrow("HTTP 503");
    expect(fetch).toHaveBeenCalledTimes(2); // Generic API never retries arbitrary writes.
  });
  it.each(["", "{", "null"])(
    "rejects an invalid successful response %j",
    async (body) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
      const result = api("/entities/a");
      await expect(result).rejects.toBeInstanceOf(ApiError);
      await expect(result).rejects.toThrow("Сохранение не подтверждено");
    },
  );
  it("confirms an already saved dislike after a lost response without writing twice", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null))
      .mockResolvedValueOnce(json(card));
    vi.stubGlobal("fetch", fetch);
    const result = saveEntityState("a", { reaction: "dislike" });
    const assertion = expect(result).resolves.toEqual(card);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual([
      "PATCH",
      "GET",
    ]);
  });
  it("retries the same explicit dislike when the proxy failed before saving", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 502 }))
      .mockResolvedValueOnce(json({ ...card, reaction: "" }))
      .mockResolvedValueOnce(json(card));
    vi.stubGlobal("fetch", fetch);
    const result = saveEntityState("a", { reaction: "dislike" });
    const assertion = expect(result).resolves.toEqual(card);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual([
      "PATCH",
      "GET",
      "PATCH",
    ]);
    expect(fetch.mock.calls[0][1].body).toBe(fetch.mock.calls[2][1].body);
  });
  it("bounds retries during an outage and returns a readable error", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 502 })),
      );
    vi.stubGlobal("fetch", fetch);
    const assertion = expect(
      saveEntityState("a", { reaction: "dislike" }),
    ).rejects.toThrow("HTTP 502");
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch).toHaveBeenCalledTimes(5); // Three writes, two targeted verification reads.
  });
  it("does not retry rejected or deleted cards", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ error: "Активность не найдена" }, 404));
    vi.stubGlobal("fetch", fetch);
    await expect(saveEntityState("a", { reaction: "dislike" })).rejects.toThrow(
      "Активность не найдена",
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("uses one request for a normal confirmed dislike", async () => {
    const fetch = vi.fn().mockResolvedValue(json(card));
    vi.stubGlobal("fetch", fetch);
    await expect(
      saveEntityState("a", { reaction: "dislike" }),
    ).resolves.toEqual(card);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("recovers a connection loss without changing an already saved dislike", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(json(card));
    vi.stubGlobal("fetch", fetch);
    const assertion = expect(
      saveEntityState("a", { reaction: "dislike" }),
    ).resolves.toEqual(card);
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetch.mock.calls.map(([, options]) => options.method)).toEqual([
      "PATCH",
      "GET",
    ]);
  });
});

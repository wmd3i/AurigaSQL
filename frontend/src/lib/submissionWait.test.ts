import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleSubmissionNotices } from "./submissionWait";

afterEach(() => vi.useRealTimers());

describe("submission wait notices", () => {
  it("reports a slow request at 15 seconds and a pending request at 60 seconds", () => {
    vi.useFakeTimers();
    const notice = vi.fn();
    const cleanup = scheduleSubmissionNotices(notice);
    vi.advanceTimersByTime(14_999);
    expect(notice).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice.mock.calls[0][0]).toContain("longer than usual");
    vi.advanceTimersByTime(45_000);
    expect(notice).toHaveBeenCalledTimes(2);
    expect(notice.mock.calls[1][0]).toContain("still pending");
    cleanup();
  });

  it.each([0, 16_000])("clears future notices when settled or unmounted after %i ms", (elapsed) => {
    vi.useFakeTimers();
    const notice = vi.fn();
    const cleanup = scheduleSubmissionNotices(notice);
    vi.advanceTimersByTime(elapsed);
    notice.mockClear();
    cleanup();
    vi.runAllTimers();
    expect(notice).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

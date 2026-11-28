/** These notices report elapsed time; they never settle or cancel the request. */
export function scheduleSubmissionNotices(onNotice: (message: string) => void): () => void {
  const slow = setTimeout(() => onNotice("Creating this conversation is taking longer than usual. Please wait."), 15_000);
  const delayed = setTimeout(() => onNotice("No response yet. The request is still pending. Sending is disabled to prevent duplicate questions."), 60_000);
  return () => {
    clearTimeout(slow);
    clearTimeout(delayed);
  };
}

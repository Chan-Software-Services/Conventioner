/** What the review's toolbar draws for the open view (T466). */
export interface ReviewViewTools {
  /** When the list was last read, its Refresh's state, and why the last re-read failed. */
  freshness: { readAt: number | null; refreshing: boolean; failed: string; ready: boolean };
  refresh(): void;
  /** The All view's Export: whether this person may, and opening its dialog. */
  mayExport?: boolean;
  openExport?(): void;
}

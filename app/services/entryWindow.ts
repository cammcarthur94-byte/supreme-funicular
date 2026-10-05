export function isEntryWindowOpen(
  status: string,
  now: Date,
  entryOpensAt: Date,
  entryClosesAt: Date
): boolean {
  return status === "OPEN" && now.getTime() >= entryOpensAt.getTime() && now.getTime() < entryClosesAt.getTime();
}

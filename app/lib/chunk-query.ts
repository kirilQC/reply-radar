/**
 * PostgREST filters live in the URL, so `id=in.(...)` grows with the number of ids and
 * eventually returns a 414 that takes the whole endpoint down. Batch the ids instead.
 *
 * Batches are also kept small enough that a single response stays under PostgREST's
 * default 1000-row ceiling (relevant when each id fans out to many rows, e.g. messages).
 */
export async function queryByIds<T>(
  ids: string[],
  batchSize: number,
  run: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (!ids.length) return [];
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += batchSize) {
    batches.push(ids.slice(index, index + batchSize));
  }
  const results = await Promise.all(batches.map(run));
  return results.flat();
}

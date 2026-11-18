const AppError = require('../../utils/AppError');

/**
 * Sorting and cursor ("keyset") pagination for the product list.
 *
 * Why not skip/limit: skip(n) reads and throws away n rows, so deep pages get slower, and a
 * product inserted while the user pages shifts every row and causes duplicates or gaps. A
 * cursor remembers the LAST row seen (its sort value and its _id) and asks for "the rows after
 * it", which is a fast index range scan and stable under inserts.
 *
 * The cursor is opaque to clients: base64url(JSON {s, v, id}). It is bound to the sort it was
 * issued for, and validated, so a tampered or mismatched cursor is a 422, never a query.
 */
const SORTS = {
  newest: { field: 'createdAt', dir: -1, date: true },
  price_asc: { field: 'priceKobo', dir: 1 },
  price_desc: { field: 'priceKobo', dir: -1 },
  rating: { field: 'ratingAvg', dir: -1 },
};
const SORT_NAMES = Object.keys(SORTS);
const OBJECT_ID = /^[a-f0-9]{24}$/;

const sortValue = (sort, record) => (SORTS[sort].date ? +record[SORTS[sort].field] : record[SORTS[sort].field]);

function encodeCursor(sort, record) {
  return Buffer.from(JSON.stringify({ s: sort, v: sortValue(sort, record), id: record.id })).toString('base64url');
}

function decodeCursor(sort, cursor) {
  const bad = () => AppError.validation([{ path: 'cursor', message: 'Invalid cursor' }], 'Invalid cursor');
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  const ok =
    parsed && parsed.s === sort && typeof parsed.v === 'number' && Number.isFinite(parsed.v) && OBJECT_ID.test(parsed.id);
  if (!ok) throw bad();
  return { value: parsed.v, id: parsed.id };
}

/**
 * MongoDB condition for "strictly after the cursor" in this sort order:
 *   field <op> value  OR  (field = value AND _id <op> id)      (op is $lt for desc, $gt for asc)
 */
function mongoAfterCursor(sort, { value, id }) {
  const { field, dir, date } = SORTS[sort];
  const op = dir === 1 ? '$gt' : '$lt';
  const v = date ? new Date(value) : value;
  return { $or: [{ [field]: { [op]: v } }, { [field]: v, _id: { [op]: id } }] };
}

/** Same rule as mongoAfterCursor, for plain objects (used by the in-memory test repository). */
function isAfterCursor(sort, record, { value, id }) {
  const { dir } = SORTS[sort];
  const v = sortValue(sort, record);
  if (v !== value) return dir === 1 ? v > value : v < value;
  return dir === 1 ? record.id > id : record.id < id;
}

/** Comparator that orders plain objects exactly like the MongoDB sort (field, then _id). */
function comparator(sort) {
  const { dir } = SORTS[sort];
  return (a, b) => {
    const av = sortValue(sort, a);
    const bv = sortValue(sort, b);
    if (av !== bv) return (av < bv ? -1 : 1) * dir;
    return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * dir;
  };
}

module.exports = { SORTS, SORT_NAMES, encodeCursor, decodeCursor, mongoAfterCursor, isAfterCursor, comparator };

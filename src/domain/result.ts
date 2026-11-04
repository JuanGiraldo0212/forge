export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const map = <T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> =>
  r.ok ? ok(f(r.value)) : r;

export const flatMap = <T, U, E>(r: Result<T, E>, f: (t: T) => Result<U, E>): Result<U, E> =>
  r.ok ? f(r.value) : r;

export const mapErr = <T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> =>
  r.ok ? r : err(f(r.error));

/** Collects every error instead of stopping at the first one. */
export const collect = <T, E>(rs: readonly Result<T, E>[]): Result<readonly T[], readonly E[]> => {
  const errors = rs.flatMap((r) => (r.ok ? [] : [r.error]));
  return errors.length > 0 ? err(errors) : ok(rs.flatMap((r) => (r.ok ? [r.value] : [])));
};

export const unwrapOr = <T, E>(r: Result<T, E>, fallback: T): T => (r.ok ? r.value : fallback);

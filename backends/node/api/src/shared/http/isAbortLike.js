// M22: таймаут fetch'а с AbortSignal.timeout — TimeoutError, ручной abort — AbortError.
// Общий для клиентов MAX и Б24: оба переводят такой сбой в kind/код «таймаут».

export function isAbortLike(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

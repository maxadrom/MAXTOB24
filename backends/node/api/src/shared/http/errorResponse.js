// Конверт ошибки в ответе: { error: { code, message, requestId } }. Один на всех — errorHandler,
// rate-limit и отказы вебхуков до диспатча (секрет MAX, токен Б24). Стек и детали — только в лог.

export function errorBody(req, code, message) {
  return { error: { code, message, requestId: req.id ?? null } };
}

export function sendError(req, res, status, code, message) {
  res.status(status).json(errorBody(req, code, message));
}

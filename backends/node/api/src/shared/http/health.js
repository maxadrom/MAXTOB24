// Публичный health endpoint (без auth) — для внешнего мониторинга и Caddy-проб.
// Возвращает healthy + backend + timestamp в секундах.

export function buildHealthHandler() {
  return function health(_req, res) {
    res.json({
      status: 'healthy',
      backend: 'node',
      timestamp: Math.floor(Date.now() / 1000),
    });
  };
}

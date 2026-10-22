// Контроллеры — тонкие: парсят req, делегируют в сервис, отдают JSON.
// Ошибки бросаем через next(err) — их обработает shared/http/errorHandler.

export class InstallationsController {
  constructor(service, { logger } = {}) {
    if (!service) throw new TypeError('InstallationsController: service required');
    this.service = service;
    this.logger = logger;
  }

  handleInstall = async (req, res, next) => {
    try {
      const log = req.log ?? this.logger;
      log?.debug?.(
        { bodyKeys: Object.keys(req.body ?? {}) },
        'install payload keys',
      );
      const installation = await this.service.installFromOAuthPayload(req.body ?? {});
      res.json({
        message: 'All success',
        installation: { id: installation.id, portal: installation.b24Portal },
      });
    } catch (err) {
      next(err);
    }
  };
}

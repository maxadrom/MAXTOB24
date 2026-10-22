// Общий каркас one-time скриптов (register-*/probe-*): контекст config/logger, DI-граф
// Б24 с БД, предусловие «есть installation», MAX-клиент и CLI-обёртка. Каждый узел
// переопределяется через deps — это seam'ы smoke-тестов (ключи deps не переименовывать).

import process from 'node:process';

import { loadConfig } from '../../src/shared/config/index.js';
import { buildLogger } from '../../src/shared/logger/index.js';
import { buildPool } from '../../src/shared/db/pool.js';
import { InstallationsRepository } from '../../src/modules/installations/installationsRepository.js';
import { InstallationsService } from '../../src/modules/installations/installationsService.js';
import { B24Client } from '../../src/modules/b24/b24Client.js';
import { MaxClient } from '../../src/modules/max/maxClient.js';

function childOf(logger, bindings) {
  return logger.child ? logger.child(bindings) : logger;
}

// config + logger с полем script=<name>.
export function scriptContext(name, deps = {}) {
  const config = deps.config ?? loadConfig();
  const logger = childOf(deps.logger ?? buildLogger(config), { script: name });
  return { config, logger };
}

// Граф Б24-скриптов: pool → installations (репозиторий + сервис-фасад) → B24Client.
// pg.Pool ленивый (коннект на первом запросе), поэтому граф можно собрать до проверок
// предусловий. close() закрывает пул, только если он создан здесь — чужой из deps не трогаем.
export function b24Graph({ config, logger }, deps = {}) {
  const ownsPool = !deps.pool;
  const pool = deps.pool ?? buildPool(config, logger);
  const installationsLogger = childOf(logger, { module: 'installations' });
  const installationsRepo = deps.installationsRepo ?? new InstallationsRepository(pool, installationsLogger);
  const installations = deps.installations ?? new InstallationsService(installationsRepo, installationsLogger);
  const b24Client =
    deps.b24Client ??
    new B24Client({ installationsService: installations, config: config.b24, logger });
  return {
    pool,
    installations,
    b24Client,
    close: async () => {
      if (ownsPool) await pool.end().catch(() => {});
    },
  };
}

// Предусловие Б24-скриптов: на портале пройден POST /api/install (есть b24_access_token).
// Через фасад installationsService, не в репозиторий напрямую.
// M26: после удаления приложения (ONAPPUNINSTALL) токенов нет — подсказка про переустановку.
export async function requireInstallation(installations, portal, scriptName) {
  const installation = await installations.findByPortal(portal);
  if (installation?.isUninstalled?.()) {
    const at = installation.uninstalledAt instanceof Date
      ? installation.uninstalledAt.toISOString()
      : String(installation.uninstalledAt);
    throw new Error(
      `Bitrix24 app was uninstalled at ${at} — reinstall it ` +
        `(re-save the app form, POST /api/install), then re-run ${scriptName}.`,
    );
  }
  if (!installation || !installation.b24AccessToken) {
    throw new Error(
      `No installation with b24_access_token for portal "${portal}". ` +
        `Complete POST /api/install from the portal first, then re-run ${scriptName}.`,
    );
  }
  return installation;
}

// MAX-клиент из config.max. Логгер без child: MaxClient сам добавляет component.
export function maxClientFor({ config, logger }, deps = {}) {
  return (
    deps.maxClient ??
    new MaxClient({ baseUrl: config.max.apiBaseUrl, token: config.max.botToken, logger })
  );
}

// CLI-обёртка: process.exit живёт только здесь, runScript тестируется без него.
// Коды выхода: 0 — успех; notOkExitCode — результат { ok:false } (пробы отдают 2);
// 1 — исключение (+ код Б24, если это B24ApiError). logger мог не успеть создаться —
// поэтому console.
export function runCli(name, runScript, { notOkExitCode = 0, exit = process.exit } = {}) {
  return runScript().then(
    (result) => exit(result?.ok === false ? notOkExitCode : 0),
    (err) => {
      // eslint-disable-next-line no-console
      console.error(`${name} failed:`, err?.message ?? err);
      if (err?.b24Code) {
        // eslint-disable-next-line no-console
        console.error('  B24 code:', err.b24Code, '—', err.b24Description ?? '');
      }
      exit(1);
    },
  );
}

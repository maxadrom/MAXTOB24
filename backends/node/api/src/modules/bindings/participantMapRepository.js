import { ParticipantMap } from './models/ParticipantMap.js';

export class ParticipantMapRepository {
  constructor(pool, logger) {
    this.pool = pool;
    this.logger = logger?.child ? logger.child({ layer: 'repository' }) : logger;
  }

  // Участник и его последнее имя. M21: запись — только для нового участника или при смене
  // имени; иначе строка не трогается (до M21 каждое входящее давало UPDATE). null-имя старое
  // не стирает. → ParticipantMap, если строка записана, иначе null.
  async upsert({ bindingId, maxUserId, maxDisplayName = null }) {
    this.logger?.debug({ bindingId, maxUserId }, 'participantMap.upsert');
    const { rows } = await this.pool.query(
      `INSERT INTO participant_map (binding_id, max_user_id, max_display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (binding_id, max_user_id) DO UPDATE
         SET max_display_name = EXCLUDED.max_display_name
         WHERE EXCLUDED.max_display_name IS NOT NULL
           AND participant_map.max_display_name IS DISTINCT FROM EXCLUDED.max_display_name
       RETURNING *`,
      [bindingId, maxUserId, maxDisplayName],
    );
    return ParticipantMap.fromRow(rows[0]);
  }

  // M23: последнее известное имя участника (пишет upsert с входящих)
  // либо null, если участника нет. max_user_id — text, поэтому String().
  async findDisplayName(bindingId, maxUserId) {
    this.logger?.debug({ bindingId, maxUserId }, 'participantMap.findDisplayName');
    const { rows } = await this.pool.query(
      `SELECT max_display_name FROM participant_map
       WHERE binding_id = $1 AND max_user_id = $2`,
      [bindingId, String(maxUserId)],
    );
    return rows[0]?.max_display_name ?? null;
  }

}

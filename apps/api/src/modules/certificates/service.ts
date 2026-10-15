import { env } from '../../config/env.js';
import { type Db, one, pool } from '../../db/pool.js';
import { randomCode } from '../../lib/crypto.js';
import { notify } from '../../lib/notify.js';

export const verifyUrl = (code: string) => `${env.WEB_URL}/verify/${code}`;

/** Issue a certificate with a unique QR verification code (FR-PLC-26). */
export async function issueCertificate(
  input: {
    personId: string;
    placementId?: string | null;
    kind: 'btbg_programme' | 'training';
    title: string;
    programme: string;
    outcome?: string | null;
    ncMapping?: string | null;
    issuedBy: string | null;
  },
  db: Db = pool,
) {
  let code = '';
  for (let i = 0; i < 5; i++) {
    code = `BTBG-${randomCode(8)}`;
    if (!(await one('select 1 from certificates where verification_code = $1', [code], db))) break;
  }
  const row = await one<{ id: string }>(
    `insert into certificates (person_id, placement_id, kind, title, programme, outcome, nc_mapping, verification_code, issued_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
    [input.personId, input.placementId ?? null, input.kind, input.title, input.programme, input.outcome ?? null, input.ncMapping ?? null, code, input.issuedBy],
    db,
  );
  const person = await one<{ user_id: string | null; mobile: string }>('select user_id, mobile from person_profiles where id = $1', [input.personId], db);
  await notify({ userId: person?.user_id, mobile: person?.mobile, code: 'certificate_issued', vars: { link: verifyUrl(code) } }, db);
  return { id: row!.id, code, verifyUrl: verifyUrl(code) };
}

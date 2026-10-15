import { z } from 'zod';
import { one, pool, tx } from '../db/pool.js';
import { zMobile } from '../lib/http.js';
import { hashPassword } from '../modules/auth/service.js';

/**
 * Creates the first Super Admin on a fresh database (no demo data).
 * Usage: npm run db:create-admin -- <mobile> "<full name>" "<temporary password>"
 * They are asked to set up two-step sign-in the first time they log in.
 */
const [mobileArg, name, password] = process.argv.slice(2);
const args = z.object({ mobile: zMobile, name: z.string().trim().min(2), password: z.string().min(10, 'use at least 10 characters') })
  .safeParse({ mobile: mobileArg, name, password });
if (!args.success) {
  console.error('Usage: npm run db:create-admin -- 17xxxxxx "Full Name" "TemporaryPassword"\n' + args.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}
const { mobile } = args.data;
await tx(async (db) => {
  const existing = await one<{ id: string }>('select id from users where mobile = $1', [mobile], db);
  const id = existing?.id ?? (await one<{ id: string }>(
    `insert into users (mobile, password_hash, full_name, mobile_verified_at, contact_confirmed_at) values ($1,$2,$3,now(),now()) returning id`,
    [mobile, await hashPassword(args.data.password), args.data.name], db))!.id;
  await db.query(`insert into user_roles (user_id, role_code) values ($1, 'super_admin') on conflict do nothing`, [id]);
  console.log(`Super Admin ready: ${mobile}${existing ? ' (existing account given the role)' : ''}`);
});
await pool.end();

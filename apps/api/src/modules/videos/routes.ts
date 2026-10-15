import { z } from 'zod';
import { env } from '../../config/env.js';
import { one, query, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, zDate } from '../../lib/http.js';
import { containsProfanity } from '../../lib/profanity.js';
import { newKey, putFile, validateUpload } from '../../lib/storage.js';
import { sendStored } from '../files/routes.js';
import { ffmpegAvailable, transcodeVideo } from './transcode.js';

/** Vocational Video Campaign (SRS 3.6, Workflow 7). Viewing needs no login (FR-VID-05). */
const m = createModule('/campaign', 'Vocational Video Campaign');
export default m;

const CURATOR = { any: ['videos.manage'] };
const REVIEWER = { any: ['videos.review'] };
const MODERATOR = { any: ['qa.moderate'] };
const PIPELINE = ['idea', 'filming', 'editing', 'review', 'consent_confirmed', 'scheduled', 'published', 'archived'] as const;

// ---------------------------------------------------------------------------
// Public: careers, videos, streaming, Q&A, analytics events
// ---------------------------------------------------------------------------
const linkedVacancies = (careerId: string) =>
  query(
    `select v.id, v.title, v.share_slug as slug, v.wage, o.name as host, d.name as dzongkhag
       from vacancies v join organisations o on o.id = v.org_id left join dzongkhags d on d.id = v.dzongkhag_id
       join careers c on c.id = $1
      where v.status = 'open' and o.status = 'active'
        and (v.career_id = c.id or exists (select 1 from unnest(c.role_keywords) k where v.title ilike '%' || k || '%'))
      order by v.opened_at desc limit 6`, [careerId]);

const linkedTraining = (careerId: string) =>
  query(`select id, title, provider, description, start_date as "startDate", link from training_programmes
          where career_id = $1 or sector_code = (select sector_code from careers where id = $1) order by start_date nulls last limit 6`, [careerId]);

const publicVideoCols = `v.id, v.title, v.description, v.kind, v.duration_seconds as "durationSeconds", v.language, v.published_at as "publishedAt",
  v.thumbnail_path is not null as "hasThumbnail", c.slug as "careerSlug", c.title as "careerTitle",
  coalesce((select array_agg(t.slug) from video_tags vt join tags t on t.id = vt.tag_id where vt.video_id = v.id), '{}') as tags,
  (select count(*)::int from video_events e where e.video_id = v.id and e.type = 'view') as views`;

m.route({ method: 'get', path: '/tags', summary: 'Video categories', access: 'public' }, async () => query('select slug, name from tags order by id'));

m.route({ method: 'get', path: '/careers', summary: 'Career pages', access: 'public', query: z.object({ q: z.string().optional(), sector: z.string().optional() }) },
  async ({ query: q }) =>
    query(`select c.id, c.slug, c.title, c.summary, c.sector_code as "sectorCode", c.wage_min as "wageMin", c.wage_max as "wageMax",
                  (select count(*)::int from videos v where v.career_id = c.id and v.status = 'published') as videos,
                  (select v.id from videos v where v.career_id = c.id and v.status = 'published' and v.thumbnail_path is not null order by v.published_at desc limit 1) as "coverVideoId"
             from careers c where ($1::text is null or c.title ilike '%' || $1 || '%') and ($2::text is null or c.sector_code = $2) order by c.title`,
    [q.q ?? null, q.sector ?? null]),
);

m.route({ method: 'get', path: '/careers/:slug', summary: 'Career page with videos, vacancies and training (FR-VID-02, 10)', access: 'public' }, async ({ params }) => {
  const c = await one(`select c.*, s.name as sector from careers c left join sectors s on s.code = c.sector_code where c.slug = $1`, [params.slug]);
  if (!c) throw notFound('Career');
  const [videos, vacancies, training] = await Promise.all([
    query(`select ${publicVideoCols} from videos v join careers c on c.id = v.career_id where v.career_id = $1 and v.status = 'published' order by v.published_at desc`, [c.id]),
    linkedVacancies(c.id),
    linkedTraining(c.id),
  ]);
  return {
    id: c.id, slug: c.slug, title: c.title, sector: c.sector, summary: c.summary, dailyTasks: c.daily_tasks, skills: c.skills,
    trainingRoutes: c.training_routes, wageMin: c.wage_min, wageMax: c.wage_max, growthPath: c.growth_path, videos, vacancies, training,
  };
});

m.route({ method: 'get', path: '/videos', summary: 'Published videos', access: 'public',
  query: z.object({ tag: z.string().optional(), career: z.string().optional(), kind: z.enum(['short', 'long']).optional(), q: z.string().optional() }) },
async ({ query: q }) =>
  query(`select ${publicVideoCols} from videos v join careers c on c.id = v.career_id
          where v.status = 'published'
            and ($1::text is null or exists (select 1 from video_tags vt join tags t on t.id = vt.tag_id where vt.video_id = v.id and t.slug = $1))
            and ($2::text is null or c.slug = $2) and ($3::text is null or v.kind = $3)
            and ($4::text is null or v.title ilike '%' || $4 || '%' or c.title ilike '%' || $4 || '%')
          order by v.published_at desc limit 100`, [q.tag ?? null, q.career ?? null, q.kind ?? null, q.q ?? null]),
);

m.route({ method: 'get', path: '/videos/:id', summary: 'Video page with Q&A and linked opportunities', access: 'optional' }, async ({ params, auth }) => {
  const v = await one(`select ${publicVideoCols}, v.renditions, v.subtitles, v.career_id, v.status from videos v join careers c on c.id = v.career_id where v.id = $1`, [params.id]);
  if (!v || (v.status !== 'published' && !auth?.permissions.has('videos.manage'))) throw notFound('Video');
  const [questions, vacancies, training, saved] = await Promise.all([
    query(`select q.id, q.body, q.answer, q.answered_at as "answeredAt", split_part(u.full_name, ' ', 1) as asker, q.created_at as "createdAt"
             from video_questions q join users u on u.id = q.user_id where q.video_id = $1 and q.moderation_status = 'approved' order by q.created_at desc`, [v.id]),
    linkedVacancies(v.career_id),
    linkedTraining(v.career_id),
    auth ? one('select 1 from saved_videos where user_id = $1 and video_id = $2', [auth.userId, v.id]) : null,
  ]);
  const { renditions, subtitles, career_id, status, ...rest } = v;
  return {
    ...rest, status, qualities: Object.keys(renditions).sort((a, b) => Number(a) - Number(b)), subtitleLanguages: Object.keys(subtitles),
    questions, vacancies, training, saved: Boolean(saved),
    shareUrl: `${env.WEB_URL}/careers/videos/${v.id}`, registerUrl: `${env.WEB_URL}/register?career=${v.careerSlug}`,
  };
});

async function publishedVideo(id: string, allowUnpublished = false) {
  const v = await one('select * from videos where id = $1', [id]);
  if (!v || (!allowUnpublished && v.status !== 'published')) throw notFound('Video');
  return v;
}

m.route({ method: 'get', path: '/videos/:id/stream', summary: 'Stream a rendition: 240 and 360 are the low-data options', access: 'optional',
  query: z.object({ q: z.enum(['240', '360', '720', 'original']).default('360') }) },
async ({ req, res, params, query: q, auth }) => {
  const v = await publishedVideo(params.id, Boolean(auth?.permissions.has('videos.manage')));
  const key = q.q === 'original' ? v.original_path : v.renditions[q.q] ?? v.renditions['360'] ?? v.renditions['240'] ?? v.original_path;
  if (!key) throw notFound('Video file');
  return sendStored(req, res, key, { cache: 'public, max-age=86400' });
});

m.route({ method: 'get', path: '/videos/:id/thumbnail', summary: 'Video thumbnail', access: 'optional' }, async ({ req, res, params, auth }) => {
  const v = await publishedVideo(params.id, Boolean(auth?.permissions.has('videos.manage')));
  if (!v.thumbnail_path) throw notFound('Thumbnail');
  return sendStored(req, res, v.thumbnail_path, { cache: 'public, max-age=86400' });
});

m.route({ method: 'get', path: '/videos/:id/subtitles/:lang', summary: 'WebVTT subtitles (en or dz)', access: 'optional' }, async ({ req, res, params, auth }) => {
  const v = await publishedVideo(params.id, Boolean(auth?.permissions.has('videos.manage')));
  const key = v.subtitles[params.lang.replace(/\.vtt$/, '')];
  if (!key) throw notFound('Subtitles');
  return sendStored(req, res, key, { cache: 'public, max-age=86400' });
});

m.route({ method: 'post', path: '/events', summary: 'Record a view, progress, completion, share or career visit (FR-VID-30, 31)', access: 'optional',
  body: z.object({ videoId: z.string().uuid().optional(), careerSlug: z.string().optional(), viewerRef: z.string().min(8).max(64),
    type: z.enum(['view', 'progress', 'complete', 'share', 'career_visit', 'register_click']), watchSeconds: z.number().int().min(0).max(7200).default(0) }) },
async ({ body, auth }) => {
  let careerId: string | null = null;
  if (body.videoId) careerId = (await one('select career_id from videos where id = $1 and status = $2', [body.videoId, 'published']))?.career_id ?? null;
  if (body.careerSlug) careerId = (await one('select id from careers where slug = $1', [body.careerSlug]))?.id ?? careerId;
  if (!careerId) throw badRequest('Unknown video or career.');
  // One "view" per viewer per video per day keeps counts honest.
  if (body.type === 'view' && body.videoId && (await one(`select 1 from video_events where video_id = $1 and viewer_ref = $2 and type = 'view' and created_at > now() - interval '1 day'`, [body.videoId, body.viewerRef]))) {
    return { ok: true, deduplicated: true };
  }
  await query(`insert into video_events (video_id, career_id, viewer_ref, user_id, type, watch_seconds) values ($1,$2,$3,$4,$5,$6)`,
    [body.videoId ?? null, careerId, body.viewerRef, auth?.userId ?? null, body.type, body.watchSeconds]);
  return { ok: true };
});

m.route({ method: 'get', path: '/saved', summary: 'My saved videos', access: 'user' }, async ({ auth }) =>
  query(`select ${publicVideoCols} from saved_videos s join videos v on v.id = s.video_id join careers c on c.id = v.career_id where s.user_id = $1 and v.status = 'published' order by s.created_at desc`, [auth.userId]),
);
m.route({ method: 'post', path: '/videos/:id/save', summary: 'Save a video', access: 'user' }, async ({ auth, params }) => {
  await query('insert into saved_videos (user_id, video_id) values ($1, $2) on conflict do nothing', [auth.userId, params.id]);
  return { ok: true };
});
m.route({ method: 'delete', path: '/videos/:id/save', summary: 'Unsave a video', access: 'user' }, async ({ auth, params }) => {
  await query('delete from saved_videos where user_id = $1 and video_id = $2', [auth.userId, params.id]);
  return { ok: true };
});

m.route({ method: 'post', path: '/videos/:id/questions', summary: 'Ask a question; it is published after moderation', access: 'user', body: z.object({ body: z.string().trim().min(5).max(500) }) },
  async ({ auth, params, body }) => {
    await publishedVideo(params.id);
    const flagged = containsProfanity(body.body);
    await query(`insert into video_questions (video_id, user_id, body, profanity_flag) values ($1, $2, $3, $4)`, [params.id, auth.userId, body.body, flagged]);
    return { ok: true, message: 'Thank you. Your question will appear after a moderator checks it.' };
  });

m.route({ method: 'post', path: '/questions/:id/report', summary: 'Report a published question or answer', access: 'optional',
  body: z.object({ viewerRef: z.string().min(8).max(64), reason: z.string().max(200).optional() }) },
async ({ params, body, auth }) => {
  const ref = auth?.userId ?? body.viewerRef;
  const res = await query(`insert into video_question_reports (question_id, reporter_ref, reason) values ($1, $2, $3) on conflict do nothing returning question_id`, [params.id, ref, body.reason ?? null]);
  if (res.length) {
    // Three reports send a published post back to moderation.
    await query(`update video_questions set report_count = report_count + 1,
                   moderation_status = case when report_count + 1 >= 3 then 'pending' else moderation_status end where id = $1`, [params.id]);
  }
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Curator: careers, training programmes, videos and the publishing pipeline
// ---------------------------------------------------------------------------
const careerBody = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/).min(2), title: z.string().min(2), sectorCode: z.string().nullable(), summary: z.string().nullable(),
  dailyTasks: z.string().nullable(), skills: z.array(z.string()).default([]), trainingRoutes: z.string().nullable(), wageMin: z.number().nullable(),
  wageMax: z.number().nullable(), growthPath: z.string().nullable(), roleKeywords: z.array(z.string()).default([]),
});

m.route({ method: 'post', path: '/careers', summary: 'Create a career page', access: CURATOR, body: careerBody }, async ({ body }) =>
  one(`insert into careers (slug, title, sector_code, summary, daily_tasks, skills, training_routes, wage_min, wage_max, growth_path, role_keywords)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
  [body.slug, body.title, body.sectorCode, body.summary, body.dailyTasks, body.skills, body.trainingRoutes, body.wageMin, body.wageMax, body.growthPath, body.roleKeywords]),
);

m.route({ method: 'put', path: '/careers/:id', summary: 'Update a career page', access: CURATOR, body: careerBody }, async ({ params, body }) => {
  await query(`update careers set slug=$2, title=$3, sector_code=$4, summary=$5, daily_tasks=$6, skills=$7, training_routes=$8, wage_min=$9, wage_max=$10, growth_path=$11, role_keywords=$12 where id = $1`,
    [params.id, body.slug, body.title, body.sectorCode, body.summary, body.dailyTasks, body.skills, body.trainingRoutes, body.wageMin, body.wageMax, body.growthPath, body.roleKeywords]);
  return { ok: true };
});

m.route({ method: 'get', path: '/training', summary: 'Training programmes', access: 'public' }, async () =>
  query(`select t.id, t.title, t.provider, t.description, t.start_date as "startDate", t.link, c.title as career from training_programmes t left join careers c on c.id = t.career_id order by t.start_date nulls last`),
);
m.route({ method: 'post', path: '/training', summary: 'Add a training programme', access: CURATOR,
  body: z.object({ title: z.string().min(2), provider: z.string().min(2), careerId: z.string().uuid().nullable(), sectorCode: z.string().nullable(), dzongkhagId: z.number().int().nullable(),
    description: z.string().nullable(), startDate: zDate.nullable(), link: z.string().url().nullable() }) },
async ({ body }) =>
  one(`insert into training_programmes (title, provider, career_id, sector_code, dzongkhag_id, description, start_date, link) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [body.title, body.provider, body.careerId, body.sectorCode, body.dzongkhagId, body.description, body.startDate, body.link]),
);

m.route({ method: 'get', path: '/admin/videos', summary: 'All videos in the pipeline', access: { any: ['videos.manage', 'videos.review'] } }, async () =>
  query(`select v.id, v.title, v.status, v.kind, v.processing_status as "processingStatus", v.duration_seconds as "durationSeconds", v.scheduled_at as "scheduledAt",
                v.published_at as "publishedAt", c.title as career, v.updated_at as "updatedAt",
                (select count(*)::int from video_featured_people f where f.video_id = v.id) as people,
                (select count(*)::int from video_featured_people f where f.video_id = v.id and f.consent_status = 'confirmed') as "consentsConfirmed"
           from videos v join careers c on c.id = v.career_id order by v.updated_at desc`),
);

m.route({ method: 'get', path: '/admin/videos/:id', summary: 'Video record for curators', access: { any: ['videos.manage', 'videos.review'] } }, async ({ params }) => {
  const v = await one(`select v.*, c.title as career_title from videos v join careers c on c.id = v.career_id where v.id = $1`, [params.id]);
  if (!v) throw notFound('Video');
  const [people, tags] = await Promise.all([
    query(`select id, name, role_title as "roleTitle", is_minor as "isMinor", consent_file is not null as "hasConsent", guardian_name as "guardianName",
                  guardian_consent_file is not null as "hasGuardianConsent", consent_status as "consentStatus", withdrawn_at as "withdrawnAt", withdrawal_reason as "withdrawalReason"
             from video_featured_people where video_id = $1 order by created_at`, [params.id]),
    query(`select t.slug from video_tags vt join tags t on t.id = vt.tag_id where vt.video_id = $1`, [params.id]),
  ]);
  return { ...v, people, tags: tags.map((t) => t.slug), ffmpeg: await ffmpegAvailable() };
});

const videoMeta = z.object({ careerId: z.string().uuid(), title: z.string().min(2).max(140), description: z.string().max(3000).nullable().default(null),
  language: z.enum(['dz', 'en', 'mixed']).default('dz'), tags: z.array(z.string()).default([]) });

async function setTags(videoId: string, slugs: string[], db: any) {
  await db.query('delete from video_tags where video_id = $1', [videoId]);
  await db.query(`insert into video_tags (video_id, tag_id) select $1, id from tags where slug = any($2)`, [videoId, slugs]);
}

m.route({ method: 'post', path: '/admin/videos', summary: 'Create a video at Idea stage', access: CURATOR, body: videoMeta }, async ({ body, auth }) =>
  tx(async (db) => {
    const v = await one(`insert into videos (career_id, title, description, language, created_by) values ($1,$2,$3,$4,$5) returning id`, [body.careerId, body.title, body.description, body.language, auth.userId], db);
    await setTags(v!.id, body.tags, db);
    return v;
  }),
);

m.route({ method: 'put', path: '/admin/videos/:id', summary: 'Edit title, description and tags', access: CURATOR, body: videoMeta }, async ({ params, body }) =>
  tx(async (db) => {
    await db.query(`update videos set career_id = $2, title = $3, description = $4, language = $5 where id = $1`, [params.id, body.careerId, body.title, body.description, body.language]);
    await setTags(params.id, body.tags, db);
    return { ok: true };
  }),
);

m.route({ method: 'post', path: '/admin/videos/:id/file', summary: 'Upload the edited video; it is transcoded with thumbnails', access: CURATOR, upload: true },
  async ({ params, file, auth }) => {
    if (!file) throw badRequest('Attach the video file.');
    const mime = validateUpload('video', file);
    const v = await one('select id, status from videos where id = $1', [params.id]);
    if (!v) throw notFound('Video');
    const key = await putFile(newKey(`videos/${params.id}/original`, file.originalname), file.buffer, mime);
    await query(`update videos set original_path = $2, renditions = '{}', processing_status = 'processing', status = case when status in ('idea','filming') then 'editing' else status end where id = $1`, [params.id, key]);
    await audit({ actorId: auth.userId, action: 'video.uploaded', entityType: 'video', entityId: params.id });
    if (await ffmpegAvailable()) void transcodeVideo(params.id, key);
    else await query(`update videos set renditions = jsonb_build_object('360', $2::text), processing_status = 'ready' where id = $1`, [params.id, key]);
    return { ok: true, processing: true };
  });

m.route({ method: 'post', path: '/admin/videos/:id/subtitles', summary: 'Upload WebVTT subtitles', access: CURATOR, upload: true, body: z.object({ language: z.enum(['en', 'dz']) }) },
  async ({ params, file, body }) => {
    if (!file) throw badRequest('Attach a .vtt file.');
    validateUpload('subtitle', file);
    const key = await putFile(`videos/${params.id}/subtitles-${body.language}.vtt`, file.buffer, 'text/vtt');
    await query(`update videos set subtitles = subtitles || jsonb_build_object($2::text, $3::text) where id = $1`, [params.id, body.language, key]);
    return { ok: true };
  });

m.route({ method: 'post', path: '/admin/videos/:id/people', summary: 'Add a featured person', access: CURATOR,
  body: z.object({ name: z.string().min(2), roleTitle: z.string().optional(), isMinor: z.boolean().default(false), guardianName: z.string().optional() }) },
async ({ params, body }) => {
  if (body.isMinor && !body.guardianName) throw badRequest('A minor needs a parent or guardian named.');
  return one(`insert into video_featured_people (video_id, name, role_title, is_minor, guardian_name) values ($1,$2,$3,$4,$5) returning id`,
    [params.id, body.name, body.roleTitle ?? null, body.isMinor, body.guardianName ?? null]);
});

/** FR-VID-21: signed consent from every featured person, and a guardian for minors. */
m.route({ method: 'post', path: '/admin/people/:personId/consent', summary: 'Upload a signed consent form', access: CURATOR, upload: true,
  body: z.object({ kind: z.enum(['person', 'guardian']) }) },
async ({ params, file, body, auth }) =>
  tx(async (db) => {
    if (!file) throw badRequest('Attach the signed consent form.');
    const mime = validateUpload('document', file);
    const person = await one('select * from video_featured_people where id = $1 for update', [params.personId], db);
    if (!person) throw notFound('Featured person');
    if (person.consent_status === 'withdrawn') throw ruleViolation('This person withdrew consent.');
    const key = await putFile(newKey(`videos/${person.video_id}/consent`, file.originalname), file.buffer, mime);
    await db.query(`update video_featured_people set ${body.kind === 'person' ? 'consent_file' : 'guardian_consent_file'} = $2 where id = $1`, [params.personId, key]);
    await db.query(`update video_featured_people set consent_status = 'confirmed'
                     where id = $1 and consent_file is not null and (not is_minor or guardian_consent_file is not null)`, [params.personId]);
    await audit({ actorId: auth.userId, action: 'video.consent_uploaded', entityType: 'video', entityId: person.video_id, details: { person: person.name, kind: body.kind } }, db);
    return { ok: true };
  }),
);

/** FR-VID-23: consent withdrawal unpublishes the video (well within 2 working days) and logs the reason. */
m.route({ method: 'post', path: '/admin/people/:personId/withdraw', summary: 'Record a consent withdrawal', access: CURATOR, body: z.object({ reason: z.string().min(3) }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const person = await one('select * from video_featured_people where id = $1', [params.personId], db);
      if (!person) throw notFound('Featured person');
      await db.query(`update video_featured_people set consent_status = 'withdrawn', withdrawn_at = now(), withdrawal_reason = $2 where id = $1`, [params.personId, body.reason]);
      await db.query(`update videos set status = case when status in ('published','scheduled','consent_confirmed') then 'archived' else status end,
                             unpublished_reason = $2, unpublish_due_at = null where id = $1`, [person.video_id, `Consent withdrawn by ${person.name}: ${body.reason}`]);
      await audit({ actorId: auth.userId, action: 'video.consent_withdrawn', entityType: 'video', entityId: person.video_id, ip, details: { person: person.name, reason: body.reason } }, db);
      return { ok: true, unpublished: true };
    }),
);

m.route({ method: 'post', path: '/admin/videos/:id/status', summary: 'Move a video through the publishing pipeline', access: { any: ['videos.manage', 'videos.review'] },
  body: z.object({ status: z.enum(PIPELINE), comment: z.string().optional(), scheduledAt: z.string().datetime({ offset: true }).optional() }) },
async ({ params, body, auth, ip }) =>
  tx(async (db) => {
    const v = await one('select * from videos where id = $1 for update', [params.id], db);
    if (!v) throw notFound('Video');
    const from = PIPELINE.indexOf(v.status);
    const to = PIPELINE.indexOf(body.status);
    const reviewerStep = ['consent_confirmed', 'scheduled', 'published'].includes(body.status) || (v.status === 'review' && to < from);
    if (reviewerStep && !auth.permissions.has('videos.review')) throw ruleViolation('A reviewer must approve this step.');
    if (body.status !== 'archived' && to > from + 1 && !(body.status === 'published' && v.status === 'consent_confirmed')) {
      throw ruleViolation(`Move one step at a time: ${v.status} → ${PIPELINE[from + 1]}.`);
    }
    if (to >= PIPELINE.indexOf('review') && body.status !== 'archived') {
      if (!v.original_path) throw ruleViolation('Upload the edited video first.');
      if (!v.subtitles.en || !v.subtitles.dz) throw ruleViolation('Add English and Dzongkha subtitles before review (FR-VID-04).');
    }
    if (to >= PIPELINE.indexOf('consent_confirmed') && body.status !== 'archived') {
      const people = await query(`select name, consent_status from video_featured_people where video_id = $1`, [params.id], db);
      if (!people.length) throw ruleViolation('Add every featured person and their consent forms.');
      const missing = people.filter((p) => p.consent_status !== 'confirmed');
      // FR-VID-21: publishing is blocked until every consent is confirmed.
      if (missing.length) throw ruleViolation(`Consent is missing for: ${missing.map((p) => p.name).join(', ')}.`);
      if (v.processing_status !== 'ready') throw ruleViolation('Wait for video processing to finish.');
    }
    if (body.status === 'scheduled' && !body.scheduledAt) throw badRequest('Choose when to publish.');
    await db.query(
      `update videos set status = $2, review_comment = coalesce($3, review_comment), reviewed_by = case when $4 then $5 else reviewed_by end,
              scheduled_at = case when $2 = 'scheduled' then $6::timestamptz else scheduled_at end,
              published_at = case when $2 = 'published' then coalesce(published_at, now()) else published_at end
        where id = $1`,
      [params.id, body.status, body.comment ?? null, reviewerStep, auth.userId, body.scheduledAt ?? null]);
    await audit({ actorId: auth.userId, action: 'video.status', entityType: 'video', entityId: params.id, ip, details: { from: v.status, to: body.status } }, db);
    return { ok: true };
  }),
);

// Q&A moderation (FR-VID-12, 13)
m.route({ method: 'get', path: '/admin/questions', summary: 'Questions awaiting moderation or answers', access: MODERATOR,
  query: z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }) },
async ({ query: q }) =>
  query(`select q.id, q.body, q.answer, q.moderation_status as status, q.profanity_flag as "profanityFlag", q.report_count as "reportCount", q.created_at as "createdAt",
                v.id as "videoId", v.title as video, u.full_name as asker
           from video_questions q join videos v on v.id = q.video_id join users u on u.id = q.user_id where q.moderation_status = $1 order by q.created_at`, [q.status]),
);

m.route({ method: 'post', path: '/admin/questions/:id', summary: 'Approve, reject or answer a question', access: MODERATOR,
  body: z.object({ decision: z.enum(['approved', 'rejected']), answer: z.string().max(2000).optional() }) },
async ({ params, body, auth }) => {
  if (body.decision === 'approved' && body.answer && containsProfanity(body.answer)) throw badRequest('The answer contains words that are not allowed.');
  await query(`update video_questions set moderation_status = $2, answer = coalesce($3, answer), answered_by = case when $3 is not null then $4 else answered_by end,
                 answered_at = case when $3 is not null then now() else answered_at end, report_count = case when $2 = 'approved' then 0 else report_count end where id = $1`,
    [params.id, body.decision, body.answer ?? null, auth.userId]);
  return { ok: true };
});

// Campaign analytics (FR-VID-30..32)
m.route({ method: 'get', path: '/admin/analytics', summary: 'Views, watch time, completion, shares, funnel and reach', access: { any: ['videos.manage', 'reports.view'] } }, async () => {
  const [perVideo, funnel, reach, careers] = await Promise.all([
    query(`select v.id, v.title, v.duration_seconds as "durationSeconds",
                  count(*) filter (where e.type = 'view')::int as views,
                  count(distinct e.viewer_ref) filter (where e.type = 'view')::int as "uniqueViewers",
                  round(avg(e.watch_seconds) filter (where e.type in ('progress','complete')), 1) as "avgWatchSeconds",
                  case when count(*) filter (where e.type = 'view') = 0 then 0
                       else round(100.0 * count(*) filter (where e.type = 'complete') / count(*) filter (where e.type = 'view'), 1) end as "completionRate",
                  count(*) filter (where e.type = 'share')::int as shares
             from videos v left join video_events e on e.video_id = v.id where v.status in ('published','archived') group by v.id order by views desc`),
    one(`with viewers as (select distinct viewer_ref from video_events where type = 'view'),
              visits as (select distinct viewer_ref from video_events where type = 'career_visit'),
              regs as (select u.id from users u where u.signup_viewer_ref in (select viewer_ref from viewers union select viewer_ref from visits)),
              apps as (select distinct p.id from person_profiles p join applications a on a.person_id = p.id where p.user_id in (select id from regs)),
              placed as (select distinct p.id from person_profiles p join placements pl on pl.person_id = p.id where p.user_id in (select id from regs) and pl.status in ('active','ending','ended','converted'))
         select (select count(*) from viewers)::int as "videoViews", (select count(*) from visits)::int as "careerVisits", (select count(*) from regs)::int as registrations,
                (select count(*) from apps)::int as applications, (select count(*) from placed)::int as placements`),
    query(`select coalesce(d.name, 'Unknown') as dzongkhag,
                  case when p.date_of_birth is null then 'Unknown' when age(p.date_of_birth) < interval '18 years' then 'Under 18'
                       when age(p.date_of_birth) < interval '25 years' then '18-24' when age(p.date_of_birth) < interval '30 years' then '25-29' else '30+' end as "ageBand",
                  coalesce(p.gender, 'unknown') as gender, count(distinct e.viewer_ref)::int as viewers
             from video_events e join users u on u.id = e.user_id or u.signup_viewer_ref = e.viewer_ref
             join person_profiles p on p.user_id = u.id left join dzongkhags d on d.id = p.dzongkhag_id
            where e.type = 'view' group by 1, 2, 3 having count(distinct e.viewer_ref) >= 10 order by viewers desc`),
    query(`select c.title, count(*) filter (where e.type = 'view')::int as views, count(*) filter (where e.type = 'career_visit')::int as visits,
                  count(*) filter (where e.type = 'register_click')::int as registrations
             from careers c left join video_events e on e.career_id = c.id group by c.id order by views desc`),
  ]);
  // FR-VID-32: reach is only shown for groups of 10 or more people.
  return { perVideo, funnel, reach, reachMinimumGroup: 10, careers };
});

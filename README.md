# BTBG Digital Platform

The BTBG (Bey Tsub Bey Gay) Employer of Record platform, built from SRS v1.0. BTBG employs and pays young
job seekers, places them with verified host employers, supervises each placement and runs a vocational
video campaign.

| Part | Technology | Folder |
|---|---|---|
| Website and portals | Next.js 15 (React 19, Tailwind 4) | `apps/web` |
| API, jobs and business rules | Node.js 20+, Express 5, TypeScript | `apps/api` |
| Database and file storage | Supabase (Postgres and Storage) | `supabase/migrations` |

## What is in it

- **Public site:** job board with filters, job pages with one-tap apply, career pages with videos
  (240p/360p/720p, Dzongkha and English subtitles, Q&A), a page for employers, certificate
  verification, a privacy notice and help. It works as an installable app with an offline page.
- **Accounts:** registration with an SMS code and recorded consent, password sign-in, two-step
  sign-in for all staff, account lockout, password reset, role switching, and contact re-confirmation.
- **Job seeker and apprentice portal:** an autosaving profile (skills, education with files, work
  history, a photo and video portfolio, bank account), recommended jobs, applications, saved jobs
  and job alerts. Apprentices also get contract signing by SMS code, their placement and check-ins,
  move requests, ratings, payslips and certificates.
- **Host employer portal:** company profile with verification documents and photos, vacancies
  (checked against the wage floor and legal hours), BTBG shortlists with Trust Profiles,
  interviews and offers, signing the placement agreement, the apprentice roster, attendance
  (only absences are marked), check-ins and ratings, requests (warning, move, end, conversion),
  invoices, reports and team users.
- **Staff back office:** dashboard with MVP measures and a risk panel, tasks, the candidate
  pipeline (assisted registration, CSV import, contact log, screening scorecards, training,
  identity and credential checks), host verification and suspension, vacancy review, matching
  and shortlisting, offers that generate the contract and agreement, placement case files,
  bench and redeployment, and placement requests.
  - Payroll uses maker and checker: one person prepares, another approves. It produces a bank
    file and payslips.
  - Billing covers invoices, payments, receivables ageing and cash exposure.
  - Also included: grievances with escalation, the helpdesk, the video campaign pipeline
    (with the consent gate), and reports exported to Excel and PDF.
  - Administration covers users, roles, settings, fee rules, scorecards, message templates,
    scheduled jobs and a tamper-evident audit log.
- **Background jobs (17):** notification delivery, placement activation, check-in reminders,
  bench timers, signing reminders, payroll and invoice reminders, helpdesk and grievance targets,
  job alerts, scheduled video publishing and housekeeping. They run on Bhutan time.

## Set up with your Supabase project

You need Node.js 20.11 or newer and a Supabase project.

1. **Install packages**

   ```bash
   npm install
   ```

2. **Create your settings file and paste your Supabase details**

   ```bash
   cp .env.example .env              # macOS / Linux
   copy .env.example .env            # Windows cmd
   Copy-Item .env.example .env       # Windows PowerShell
   ```

   The file must sit in the top `btbg` folder, next to `package.json`. A file named `.env.local`
   there works too. Open it and paste the following values:
   - **`DATABASE_URL`** (required): in Supabase, open your project, then **Connect**, then
     **Connection string**, and copy the **URI** for the *Session pooler*. Put your database
     password in place of `[YOUR-PASSWORD]`.
   - **`SUPABASE_URL`** and **`SUPABASE_SERVICE_ROLE_KEY`**: in Supabase, open **Project Settings**,
     then **API**, and copy the *Project URL* and the *service_role* key. These are used for file
     storage. The private bucket is created automatically.
   - **`JWT_SECRET`**, **`FIELD_ENCRYPTION_KEY`** and **`WEBHOOK_SECRET`**: run `npm run secrets`
     and paste its three lines.

3. **Create the tables** (this is safe to run again; it applies only new migrations)

   ```bash
   npm run db:migrate
   ```

4. **Add demo data** (optional; recommended for trying the system)

   ```bash
   npm run db:seed
   ```

   For a real deployment, skip the demo data and create the first administrator instead:

   ```bash
   npm run db:create-admin -- 17xxxxxx "Full Name" "TemporaryPassword"
   ```

5. **Run it**

   ```bash
   npm run dev          # API on :4000 and website on :3000
   ```

   Always run the `npm run ...` commands from the top `btbg` folder. They work the same on
   Windows, macOS and Linux, including in folders whose names contain spaces or sit in OneDrive.
   Then open http://localhost:3000.

While `DEV_EXPOSE_OTP=true` and no SMS gateway is connected, every SMS code is shown on screen in a
yellow "Development mode" box.

## Demo accounts

Every demo account uses the password **`Btbg#Demo2026`**. Sign in with the mobile number. Staff
accounts also get a code for two-step sign-in, which is shown on screen in development.

| Mobile | Person | Role |
|---|---|---|
| 17000001 | Tshering Dorji | Super Admin |
| 17000002 | Pema Choden | Operations Manager |
| 17000003 | Sonam Tobgay | Field Officer |
| 17000004 | Dechen Wangmo | Finance Officer (prepares payroll) |
| 17000005 | Ugyen Tenzin | Finance Officer (approves payroll) |
| 17000006 | Kinley Yangzom | Grievance Officer |
| 17000007 | Namgay Dema | Helpdesk Agent |
| 17000008 | Jigme Norbu | Content Curator |
| 17000011 | Punakha Riverside Hotel owner | Host Owner |
| 17000012 | Yeshi Lhamo | Host Supervisor |
| 17000013 | Lobesa Farmhouse Kitchen owner | Host Owner |
| 17000020 | Karma Wangmo | Job seeker, ready for placement |
| 17000021 | Tashi Penjor | Apprentice on an active placement |

## Production

```bash
npm run build
NODE_ENV=production npm run start:api      # reads .env from the repository root
API_URL=https://api.your-domain npm run start:web
```

- **Settings:** set `NODE_ENV=production`, `DEV_EXPOSE_OTP=false`, `WEB_URL` to the public site
  address and `COOKIE_SECURE=true`.
- **Scheduled jobs:** run them in exactly one API instance (`RUN_JOBS=true`) and set
  `RUN_JOBS=false` on the others.
- **SMS:** connect a gateway with `SMS_PROVIDER=http`, `SMS_HTTP_URL` and `SMS_HTTP_TOKEN`.
  Delivery reports go to `POST /notifications/webhooks/sms-status`, signed with the
  `x-btbg-signature` HMAC header using `WEBHOOK_SECRET`.
- **Video:** install FFmpeg on the API server to get 240p/360p versions and thumbnails. Without
  it, videos are served as uploaded.
- **Business rules:** the wage floor, fees, timers and tax rates live in **Administration >
  Settings**. They are not in code, and every change is recorded.

## Checks

```bash
npm run typecheck
TEST_DATABASE_URL=postgres://... npm test   # 26 API tests on a throwaway database
```

The tests rebuild the database named in `TEST_DATABASE_URL`, so never point it at Supabase
production. API documentation is at `GET /openapi.json` on the API.

## Layout

```
apps/api/src
  modules/     one folder per area: auth, seeker, hosts, candidates, vacancies, placements,
               payroll, billing, grievances, helpdesk, videos, reports, admin, ...
  jobs/        scheduled jobs and the scheduler
  lib/         audit chain, encryption, notifications, storage, PDFs, dates
  scripts/     migrate, seed-demo, create-admin
apps/web
  app/(public) public site      app/(auth) sign-in and registration
  app/app/seeker  app/app/host  app/app/staff   the three portals
supabase/migrations   database schema (tables, constraints, row security, audit triggers)
```

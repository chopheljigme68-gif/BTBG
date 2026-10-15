-- BTBG reference data, roles, permissions and default configuration.
-- Values marked "open decision" in SRS section 6.2 are placeholders that a
-- Super Admin changes in Admin > Configuration (FR-ADM-10) before go-live.

insert into dzongkhags (name) values
  ('Bumthang'),('Chhukha'),('Dagana'),('Gasa'),('Haa'),('Lhuentse'),('Mongar'),('Paro'),
  ('Pema Gatshel'),('Punakha'),('Samdrup Jongkhar'),('Samtse'),('Sarpang'),('Thimphu'),
  ('Trashigang'),('Trashi Yangtse'),('Trongsa'),('Tsirang'),('Wangdue Phodrang'),('Zhemgang');

insert into gewogs (dzongkhag_id, name, kind)
select d.id, g.name, g.kind from dzongkhags d
join (values
  ('Punakha','Barp','gewog'),('Punakha','Chhubu','gewog'),('Punakha','Dzomo','gewog'),
  ('Punakha','Goenshari','gewog'),('Punakha','Guma','gewog'),('Punakha','Kabjisa','gewog'),
  ('Punakha','Lingmukha','gewog'),('Punakha','Shenga Bjemi','gewog'),('Punakha','Talog','gewog'),
  ('Punakha','Toepisa','gewog'),('Punakha','Toewang','gewog'),('Punakha','Khuruthang Town','thromde'),
  ('Thimphu','Thimphu Thromde','thromde'),('Thimphu','Chang','gewog'),('Thimphu','Kawang','gewog'),
  ('Thimphu','Mewang','gewog'),('Thimphu','Genekha','gewog'),
  ('Paro','Paro Town','thromde'),('Paro','Lamgong','gewog'),('Paro','Wangchang','gewog'),
  ('Paro','Shaba','gewog'),('Paro','Lungnyi','gewog'),
  ('Wangdue Phodrang','Bajo Town','thromde'),('Wangdue Phodrang','Thedtsho','gewog'),
  ('Wangdue Phodrang','Phobjikha','gewog'),('Wangdue Phodrang','Gangteng','gewog'),
  ('Chhukha','Phuentsholing Thromde','thromde'),('Sarpang','Gelephu Thromde','thromde'),
  ('Samdrup Jongkhar','Samdrup Jongkhar Thromde','thromde'),('Bumthang','Chhoekhor','gewog'),
  ('Trashigang','Trashigang Town','thromde'),('Mongar','Mongar Town','thromde')
) as g(dz, name, kind) on g.dz = d.name;

insert into sectors (code, name) values
  ('hospitality','Hospitality and F&B'),
  ('tourism','Tourism'),
  ('construction','Construction and trades'),
  ('agriculture','Agriculture'),
  ('care','Care work'),
  ('tech','Technology and innovation'),
  ('crafts','Traditional crafts'),
  ('green','Green jobs'),
  ('retail','Retail and services');

insert into skills (name, sector_code) values
  ('Housekeeping','hospitality'),('Front office','hospitality'),('Food and beverage service','hospitality'),
  ('Commis cook','hospitality'),('Bakery','hospitality'),('Bartending','hospitality'),
  ('Laundry','hospitality'),('Customer service','hospitality'),('Kitchen hygiene','hospitality'),
  ('Food handling','hospitality'),('Tour guiding','tourism'),('Driving','tourism'),
  ('Carpentry','construction'),('Masonry','construction'),('Electrical wiring','construction'),
  ('Plumbing','construction'),('Organic farming','agriculture'),('Elder care','care'),
  ('Childcare','care'),('Computer basics','tech'),('Web development','tech'),
  ('Thangka painting','crafts'),('Weaving','crafts'),('Solar installation','green'),
  ('Cash handling','retail'),('English communication',null),('First aid',null),('Fire safety',null);

insert into tags (slug, name) values
  ('emerging-industries','Emerging industries'),
  ('green-jobs','Green jobs'),
  ('traditional-crafts','Traditional crafts modernised'),
  ('tech-innovation','Tech and innovation'),
  ('hospitality-tourism','Hospitality and tourism'),
  ('care-work','Care work'),
  ('trades','Trades'),
  ('agriculture','Agriculture');

-- Roles (SRS 2.4). Apprentice and Alumni are lifecycle stages of a job seeker profile.
insert into roles (code, name, is_internal, org_scoped, description) values
  ('super_admin','Super Admin',true,false,'BTBG leadership. Full configuration and oversight.'),
  ('operations_manager','Operations Manager',true,false,'Runs placements, matching, redeployment and escalations.'),
  ('field_officer','Field Officer',true,false,'Sources, screens and follows up candidates; visits hosts.'),
  ('finance_officer','Finance Officer',true,false,'Runs apprentice payroll, invoicing and accounts.'),
  ('grievance_officer','Grievance Officer',true,false,'Named concern-handling contact, separate from placement.'),
  ('helpdesk_agent','Helpdesk Agent',true,false,'Answers support tickets.'),
  ('hr_officer','HR Officer',true,false,'Manages BTBG staff records (Release 2).'),
  ('content_curator','Content Curator',true,false,'Produces, uploads and moderates campaign videos and Q&A.'),
  ('host_owner','Host Owner / Admin',false,true,'Business owner or manager.'),
  ('host_supervisor','Host Supervisor',false,true,'Supervises apprentices day to day.'),
  ('job_seeker','Job Seeker / Apprentice',false,false,'Job seeker, apprentice or alumni.');

insert into role_permissions (role_code, permission)
select r, p from (values
  -- Operations Manager
  ('operations_manager','dashboard.view'),('operations_manager','candidates.view'),('operations_manager','candidates.manage'),
  ('operations_manager','candidates.import'),('operations_manager','candidates.screen'),('operations_manager','candidates.verify'),
  ('operations_manager','hosts.view'),('operations_manager','hosts.verify'),('operations_manager','accounts.suspend'),
  ('operations_manager','vacancies.review'),('operations_manager','vacancies.manage_any'),('operations_manager','matching.manage'),
  ('operations_manager','placements.view'),('operations_manager','placements.manage'),('operations_manager','placements.approve_end'),
  ('operations_manager','checkins.manage'),('operations_manager','grievances.escalation'),('operations_manager','billing.view'),
  ('operations_manager','payroll.view'),('operations_manager','reports.view'),('operations_manager','reports.export'),
  ('operations_manager','tasks.view'),('operations_manager','helpdesk.handle'),('operations_manager','feedback.view'),
  -- Field Officer
  ('field_officer','dashboard.view'),('field_officer','candidates.view'),('field_officer','candidates.manage'),
  ('field_officer','candidates.import'),('field_officer','candidates.screen'),('field_officer','candidates.verify'),
  ('field_officer','hosts.view'),('field_officer','vacancies.manage_any'),('field_officer','placements.view'),
  ('field_officer','checkins.manage'),('field_officer','tasks.view'),
  -- Finance Officer (maker and checker are enforced as two different people)
  ('finance_officer','dashboard.view'),('finance_officer','payroll.view'),('finance_officer','payroll.prepare'),
  ('finance_officer','payroll.approve'),('finance_officer','billing.view'),('finance_officer','billing.manage'),
  ('finance_officer','sensitive.view'),('finance_officer','reports.view'),('finance_officer','reports.export'),
  ('finance_officer','tasks.view'),('finance_officer','hosts.view'),
  -- Grievance Officer
  ('grievance_officer','grievances.handle'),('grievance_officer','grievances.view_all'),('grievance_officer','placements.view'),
  ('grievance_officer','tasks.view'),('grievance_officer','feedback.view'),('grievance_officer','reports.view'),
  -- Helpdesk
  ('helpdesk_agent','helpdesk.handle'),('helpdesk_agent','tasks.view'),
  -- HR (Release 2 module)
  ('hr_officer','tasks.view'),
  -- Content Curator
  ('content_curator','videos.manage'),('content_curator','videos.review'),('content_curator','qa.moderate'),
  ('content_curator','reports.view'),
  -- Hosts and job seekers
  ('host_owner','host.portal'),('host_owner','host.admin'),
  ('host_supervisor','host.portal'),
  ('job_seeker','seeker.portal')
) as v(r, p);

-- Super Admin gets every permission any role has, plus administration.
insert into role_permissions (role_code, permission)
select distinct 'super_admin', permission from role_permissions
where permission not in ('host.portal','host.admin','seeker.portal')
union select 'super_admin', p from unnest(array[
  'config.manage','users.manage','roles.manage','audit.view','notifications.templates',
  'grievances.handle','grievances.view_all','sensitive.view','videos.manage','videos.review','qa.moderate'
]) as p
on conflict do nothing;

insert into config_settings (key, value, description) values
  ('payroll.wage_floor', '8000', 'Training-period wage floor in Nu per month (open decision 2).'),
  ('payroll.pay_day', '25', 'Day of month apprentices are paid.'),
  ('payroll.prep_working_days', '5', 'Payroll preparation starts this many working days before pay date.'),
  ('payroll.attendance_default_days', '3', 'Days before pay date when unconfirmed attendance defaults to scheduled days.'),
  ('payroll.deductions', '[{"code":"nppf","label":"NPPF (employee share)","pct":0,"enabled":false},{"code":"tax","label":"Personal income tax","pct":0,"enabled":false}]', 'Statutory deductions as a percentage of gross (NPPF is open decision 5).'),
  ('payroll.bank_file_format', '"generic_csv"', 'Salary payment file format: generic_csv, bob_csv or bnb_txt.'),
  ('placement.redeploy_working_days', '10', 'Working days to redeploy after an HPA ends (open decision 3).'),
  ('placement.bench_pay_pct', '75', 'Percentage of contract wage paid for bench days (open decision 4).'),
  ('placement.apprenticeship_months', '6', 'Apprenticeship length in months (3 to 6).'),
  ('placement.checkin_days', '[30,60,90]', 'Days after start when check-ins are scheduled.'),
  ('placement.replacement_entitlement', '1', 'Free replacements per HPA.'),
  ('placement.replacement_period_days', '90', 'Days after placement start during which a free replacement applies.'),
  ('placement.sign_reminder_days', '5', 'Days before unsigned agreements trigger reminders.'),
  ('labour.max_hours_per_week', '48', 'Labour and Employment Act limit on contracted weekly hours.'),
  ('labour.max_days_per_week', '6', 'Maximum working days per week.'),
  ('labour.min_rest_days', '1', 'Minimum rest days per week.'),
  ('labour.min_leave_days', '12', 'Minimum annual leave days.'),
  ('billing.invoice_due_days', '15', 'Days after issue when a host invoice is due.'),
  ('billing.reminder_days', '[7,14,30]', 'Days overdue when reminders are sent; Super Admin alerted at the last one.'),
  ('grievance.target_days', '{"1":5,"2":10,"3":15}', 'Target resolution days by severity.'),
  ('grievance.first_contact', '{"1":{"hours":24},"2":{"working_days":3},"3":{"working_days":3}}', 'First contact deadline by severity.'),
  ('helpdesk.sla', '{"urgent":{"response_h":2,"resolution_h":24},"high":{"response_h":4,"resolution_h":48},"normal":{"response_h":8,"resolution_h":72},"low":{"response_h":24,"resolution_h":120}}', 'Ticket response and resolution targets in hours by priority.'),
  ('helpdesk.auto_close_days', '5', 'Close resolved tickets after this many days with no reply.'),
  ('auth.consent_version', '"2026-10-v1"', 'Current consent text version.'),
  ('auth.consent_text', '"BTBG uses your details to find you work, check your skills, make contracts and pay you. We share a short profile with employers only after you are screened. Your ID number and bank details are kept secret. You can ask to see or delete your data."', 'Plain-language consent statement shown at registration.'),
  ('auth.contact_reconfirm_days', '90', 'Days between mobile re-confirmation prompts.'),
  ('candidates.no_contact_days', '30', 'Days without contact before a follow-up task is created.'),
  ('candidates.max_contact_attempts', '3', 'Failed contact attempts before contact is marked unverified.'),
  ('seeker.nudge_days', '14', 'Days after registration without applying before a nudge is sent.'),
  ('calendar.working_days', '[1,2,3,4,5]', 'ISO weekdays counted as working days (1 = Monday).'),
  ('calendar.holidays', '[]', 'Public holidays as YYYY-MM-DD strings.'),
  ('matching.weights', '{"skills":35,"scorecard":25,"location":15,"wage":15,"availability":10}', 'Matching weights (sum 100).'),
  ('templates.employment_contract', to_jsonb($t$EMPLOYMENT CONTRACT

Between Bey Tsub Bey Gay (BTBG), the Employer, and {{apprentice_name}} (CID ending {{cid_last4}}), the Apprentice.

1. Employment. BTBG employs the Apprentice for an apprenticeship from {{start_date}} to {{end_date}}. BTBG is the legal employer for the full programme, whichever host the Apprentice works at.
2. Place of work. Daily supervision happens at a host site. The first host is {{host_name}}, role {{role_title}}. BTBG may move the Apprentice to another host without ending this contract.
3. Wage. Nu {{wage}} per month, paid by BTBG on day {{pay_day}} of each month, whether or not the host has paid BTBG.
4. Hours. {{hours_per_week}} hours per week over {{days_per_week}} days, with {{rest_days}} rest day(s) each week.
5. Leave. {{leave_days}} days of paid leave per year.
6. Waiting periods. If a placement ends, the Apprentice stays employed and is paid {{bench_pay_pct}}% of wage while BTBG finds a new host.
7. Concerns. The Apprentice may raise a concern at any time with the BTBG Grievance Officer. Raising a concern will not end the placement or lead to any adverse action.
8. Ending. The programme ends by conversion to direct hire, a move to a new host, or exit. A BTBG certificate is issued in every case.$t$::text), 'Employment Contract template (FR-PLC-10).'),
  ('templates.hpa', to_jsonb($t$HOST PLACEMENT AGREEMENT

Between Bey Tsub Bey Gay (BTBG) and {{host_name}} (trade licence {{trade_licence_no}}), the Host.

1. Nature. This is a commercial agreement. It is not an employment contract. BTBG remains the employer of every apprentice placed.
2. Placement. Apprentice {{apprentice_name}} as {{role_title}} from {{start_date}} to {{end_date}}.
3. Fees. Wage recovery of Nu {{wage}} per month, a service fee of Nu {{monthly_service_fee}} per month, an admin fee ({{admin_fee_desc}}), and a one-time placement fee of Nu {{placement_fee}}.
4. Supervision. The Host directs daily work, confirms attendance each period and gives feedback through the BTBG platform.
5. Conduct. The Host keeps a safe workplace, respects contracted hours and rest days, and does not take action against an apprentice who raises a concern.
6. Replacement. If the placement fails within {{replacement_period_days}} days of start, BTBG provides {{replacement_entitlement}} free replacement(s).
7. Ending. Either party may ask to end the placement through the platform. Ending this agreement does not end the apprentice's employment with BTBG.$t$::text), 'Host Placement Agreement template (FR-PLC-11).');

insert into screening_scorecards (sector_code, version, name, criteria, pass_threshold) values
  ('hospitality', 1, 'Hospitality screening v1', '[
    {"key":"attitude","label":"Attitude","weight":25,"max":5},
    {"key":"core_skills","label":"Core skills","weight":20,"max":5},
    {"key":"reliability","label":"Reliability","weight":20,"max":5},
    {"key":"wage_expectation","label":"Wage expectation is realistic","weight":10,"max":5},
    {"key":"relocate","label":"Willingness to relocate","weight":10,"max":5},
    {"key":"commitment","label":"Commitment to stay","weight":15,"max":5}
  ]', 60);

insert into fee_rules (name, size_tier, sector_code, placement_fee, monthly_service_fee, admin_fee_pct, admin_fee_fixed, priority) values
  ('Default (open decision 1)', null, null, 3000, 1500, 5, 0, 1000),
  ('Small hospitality host', 'small', 'hospitality', 2500, 1200, 5, 0, 100),
  ('Micro host', 'micro', null, 1500, 800, 3, 0, 200);

insert into notification_templates (code, channel, language, subject, body) values
  ('otp','sms','en',null,'BTBG code: {{code}}. It expires in 10 minutes. Do not share it.'),
  ('otp','sms','dz',null,'BTBG ཨང་རྟགས་: {{code}}། སྐར་མ་ ༡༠ ནང་ དུས་ཡོལ་འགྱོ།'),
  ('welcome','in_app','en','Welcome to BTBG','Welcome {{name}}. Complete your profile so we can match you with a fair first job.'),
  ('account_locked','sms','en',null,'BTBG: your account is locked for 15 minutes after 5 failed sign-ins. If this was not you, call BTBG.'),
  ('password_reset','email','en','Reset your BTBG password','Use this link within 15 minutes to reset your password: {{link}}'),
  ('reconfirm_mobile','sms','en',null,'BTBG: please confirm this is still your number by signing in. Keeping it current means we never lose touch.'),
  ('nudge_apply','sms','en',null,'BTBG: {{name}}, there are {{count}} open jobs near you. Apply in one tap: {{link}}'),
  ('vacancy_match','sms','en',null,'BTBG: new job "{{title}}" at {{host}}, Nu {{wage}}/month. See it: {{link}}'),
  ('application_received','in_app','en','Application received','We received your application for {{title}}. A field officer will contact you within 3 working days.'),
  ('outcome_not_selected','sms','en',null,'BTBG: thank you for applying for {{title}}. You were not selected this time. {{advice}} We will keep matching you.'),
  ('outcome_not_suitable','sms','en',null,'BTBG: thank you for your screening. You are not ready for placement yet. {{advice}} Talk to us anytime.'),
  ('shortlisted','in_app','en','Shortlisted','Your profile was shared with {{host}} for {{title}}.'),
  ('interview_booked','sms','en',null,'BTBG: interview for {{title}} at {{host}} on {{when}}. Place: {{location}}.'),
  ('interview_reminder','sms','en',null,'BTBG reminder: interview tomorrow {{when}} at {{host}}.'),
  ('contract_to_sign','sms','en',null,'BTBG: your employment contract is ready. Sign it in the app: {{link}}'),
  ('hpa_to_sign','sms','en',null,'BTBG: the Host Placement Agreement for {{apprentice}} is ready to sign: {{link}}'),
  ('placement_started','in_app','en','Placement started','Your placement at {{host}} starts {{date}}. First check-in on {{checkin}}.'),
  ('checkin_due','sms','en',null,'BTBG: your day {{day}} check-in is due. Open the app: {{link}}'),
  ('attendance_request','sms','en',null,'BTBG: please confirm attendance for {{period}} by {{deadline}}. Mark absences only: {{link}}'),
  ('attendance_defaulted','sms','en',null,'BTBG: attendance for {{period}} was not confirmed, so scheduled days were used. Contact BTBG if this is wrong.'),
  ('payslip','sms','en',null,'BTBG payslip {{period}}: net Nu {{net}} paid on {{date}}. Details in the app.'),
  ('invoice_issued','email','en','BTBG invoice {{number}}','Invoice {{number}} for {{period}}: Nu {{total}}, due {{due}}. View and pay in the host portal.'),
  ('invoice_reminder','email','en','Reminder: invoice {{number}}','Invoice {{number}} is {{days}} days overdue. Balance Nu {{balance}}.'),
  ('grievance_created','sms','en',null,'BTBG: concern {{ref}} received. First contact by {{first_contact}}. Target resolution {{target}}. Steps: Grievance Officer, then Operations Manager, then Super Admin.'),
  ('grievance_update','sms','en',null,'BTBG: update on concern {{ref}}: {{status}}.'),
  ('ticket_created','in_app','en','Ticket {{ref}}','We received your request "{{subject}}". We will reply by {{due}}.'),
  ('ticket_reply','sms','en',null,'BTBG helpdesk replied to ticket {{ref}}. Open the app to read it.'),
  ('certificate_issued','sms','en',null,'BTBG: your certificate is ready. Verify or share: {{link}}'),
  ('job_alert','in_app','en','New jobs for you','{{count}} new job(s) match your saved alert.'),
  ('alumni_survey','sms','en',null,'BTBG: are you still working at {{host}}? Reply in the app: {{link}}'),
  ('generic','in_app','en','{{subject}}','{{body}}'),
  ('generic','sms','en',null,'{{body}}'),
  ('generic','email','en','{{subject}}','{{body}}');

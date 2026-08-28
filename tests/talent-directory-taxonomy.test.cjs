const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const directoryPath = path.join(__dirname, '..', 'operations', 'talent-directory-filters.js');
const directorySource = fs.readFileSync(directoryPath, 'utf8');
const directoryCss = fs.readFileSync(path.join(__dirname, '..', 'operations', 'talent-directory-filters.css'), 'utf8');

function loadDirectory(profiles = [], librarySkills = []) {
  const listeners = {};
  const windowListeners = {};
  const document = {
    addEventListener(type, handler) {
      (listeners[type] ||= []).push(handler);
    },
    createElement() {
      return { textContent: '', innerHTML: '' };
    },
    getElementById() {
      return null;
    }
  };
  const window = {
    addEventListener(type, handler) {
      (windowListeners[type] ||= []).push(handler);
    },
    escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      })[character]);
    },
    titleCase(value) {
      return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
    },
    initials(value) {
      return String(value || '').slice(0, 2).toUpperCase();
    },
    requestAnimationFrame(callback) {
      callback();
    },
    soroSkillLibrary: {
      getActiveNames() {
        return librarySkills;
      }
    }
  };
  const instrumented = directorySource.replace(/\}\(\)\);\s*$/, `
    window.__directoryTest = {
      WORK_AREAS,
      skillRecordsFor,
      areaIdsFor,
      vaTypeLabel,
      featuredSkills,
      groupedStage,
      currentPlacementFromList,
      placementClientName,
      filterState
    };
  }());`);
  assert.notEqual(instrumented, directorySource, 'The directory test hooks must be injected.');
  const context = {
    window,
    document,
    liveApplicants: profiles,
    talentSearch: '',
    talentStatus: 'all',
    current: 'vas',
    render() {},
    console
  };
  vm.createContext(context);
  vm.runInContext(instrumented, context);

  function change(id, value) {
    (listeners.change || []).forEach(handler => handler({
      target: { id, value },
      stopImmediatePropagation() {}
    }));
  }

  return { context, window, change, helpers: window.__directoryTest };
}

function hasTalent(markup, id) {
  return markup.includes(`data-talent-id="${id}"`);
}

test('the Skill filter always groups all 50 application skills under the five work areas', () => {
  const { window, helpers } = loadDirectory([]);
  const markup = window.talentDirectory();

  assert.equal(helpers.WORK_AREAS.length, 5);
  assert.equal(helpers.WORK_AREAS.reduce((total, area) => total + area.skills.length, 0), 50);
  assert.equal((markup.match(/data-canonical-skill="true"/g) || []).length, 50);
  [
    'Medical &amp; healthcare support',
    'General administrative &amp; executive support',
    'Social media &amp; digital marketing',
    'Customer service &amp; client support',
    'E-commerce support'
  ].forEach(label => assert.match(markup, new RegExp(`<optgroup label="${label}">`)));
  assert.match(markup, /value="medical_coding"[^>]*>Medical coding support \(ICD-10, CPT, or HCPCS\)/);
});

test('applicant-reported and verified skill evidence remain separate while deduplicating the skill', () => {
  const { helpers, window } = loadDirectory([{
    id: 'both',
    full_name: 'Both Evidence',
    status: 'submitted',
    self_reported_experience_areas: ['healthcare'],
    self_reported_skills: ['Medical coding support (ICD-10, CPT, or HCPCS)', 'Patient intake and demographic updates'],
    verified_skills: ['Medical coding support (ICD-10, CPT, or HCPCS)']
  }]);
  const records = helpers.skillRecordsFor({
    self_reported_skills: ['Medical coding support (ICD-10, CPT, or HCPCS)'],
    verified_skills: ['Medical coding support (ICD-10, CPT, or HCPCS)']
  });
  assert.equal(records.length, 1);
  assert.equal(records[0].verified, true);
  assert.equal(records[0].reported, true);

  const markup = window.talentDirectory();
  assert.match(markup, /Medical coding support[\s\S]*?<small>Verified<\/small>/);
  assert.match(markup, /Patient intake and demographic updates[\s\S]*?<small>Applicant reported<\/small>/);
});

test('VA types and their canonical skills share an accessible field color class', () => {
  const { window } = loadDirectory([{
    id: 'colored',
    full_name: 'Colored Applicant',
    status: 'submitted',
    self_reported_experience_areas: ['healthcare', 'social_media'],
    self_reported_skills: [
      'Medical coding support (ICD-10, CPT, or HCPCS)',
      'Content-calendar planning'
    ],
    verified_skills: ['Medical coding support (ICD-10, CPT, or HCPCS)']
  }]);
  const markup = window.talentDirectory();

  assert.match(markup, /directory-va-type directory-area--healthcare[^>]*>Medical &amp; Healthcare VA/);
  assert.match(markup, /directory-va-type directory-area--social-media[^>]*>Social Media &amp; Digital Marketing VA/);
  assert.match(markup, /directory-skill-chip directory-area--healthcare is-verified/);
  assert.match(markup, /directory-skill-chip directory-area--social-media is-reported/);
  assert.match(directoryCss, /\.directory-area--healthcare[\s\S]*?--directory-area-bg:\s*#e8f5f2/);
  assert.match(directoryCss, /\.directory-area--general-admin[\s\S]*?--directory-area-bg:\s*#eaf2fb/);
  assert.match(directoryCss, /\.directory-area--social-media[\s\S]*?--directory-area-bg:\s*#f1ecfa/);
  assert.match(directoryCss, /\.directory-area--customer-support[\s\S]*?--directory-area-bg:\s*#fff4df/);
  assert.match(directoryCss, /\.directory-area--ecommerce[\s\S]*?--directory-area-bg:\s*#fcedea/);

  const neutralMarkup = loadDirectory([{
    id: 'neutral',
    full_name: 'Neutral Applicant',
    status: 'submitted',
    self_reported_experience_areas: ['other'],
    self_reported_skills: ['Custom specialty <script>alert(1)</script>']
  }]).window.talentDirectory();
  assert.match(neutralMarkup, /directory-va-type directory-area--other[^>]*>Other specialty/);
  assert.match(neutralMarkup, /directory-skill-chip directory-area--uncategorized is-reported/);
  assert.doesNotMatch(neutralMarkup, /directory-area--custom-specialty|directory-area--script/);
});

test('large skill sets stay compact and open a grouped one-click skills dialog', () => {
  const healthcareSkills = [
    'Patient appointment scheduling and confirmation',
    'Patient intake and demographic updates',
    'Patient reminder calls and non-clinical follow-up',
    'Insurance eligibility and benefits verification',
    'Prior authorization and referral coordination',
    'Medical billing and payment-posting support',
    'Claims preparation and follow-up',
    'Medical coding support (ICD-10, CPT, or HCPCS)',
    'EHR/EMR data entry and chart maintenance',
    'Medical-record requests and document routing'
  ];
  const { window } = loadDirectory([{
    id: 'many-skills',
    full_name: 'Many Skills',
    status: 'submitted',
    self_reported_experience_areas: ['healthcare'],
    self_reported_skills: healthcareSkills,
    verified_skills: healthcareSkills.slice(0, 2)
  }]);
  const markup = window.talentDirectory();

  assert.equal((markup.match(/<span class="directory-skill-chip/g) || []).length, 3);
  assert.match(markup, /data-directory-skills-id="many-skills" aria-label="View all 10 skills for Many Skills">10 skills<\/button><small>2 verified · 8 reported<\/small>/);
  assert.doesNotMatch(markup, />View all<\/button>/);
  assert.doesNotMatch(markup, /<dialog id="talent-skills-dialog"/);
  assert.match(directorySource, /<dialog id="talent-skills-dialog"/);
  assert.match(directorySource, /function ensureSkillsDialog\(\)/);
  assert.match(directorySource, /lastSkillsDialogTrigger\.focus\(\)/);
  assert.match(directorySource, /event\.key !== 'Enter' && event\.key !== ' '/);
  assert.match(directorySource, /function skillDialogBodyMarkup\(profile\)/);
  assert.match(directorySource, /Skills grouped by VA type/);
  assert.match(directoryCss, /\.directory-skill-list[\s\S]*?width:\s*270px/);
  assert.match(directoryCss, /\.directory-skill-dialog-grid[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
});

test('the three featured skills represent distinct VA types before repeating a type', () => {
  const profile = {
    id: 'multi-area',
    full_name: 'Multi Area',
    status: 'submitted',
    self_reported_experience_areas: ['healthcare', 'general_admin', 'social_media'],
    self_reported_skills: [
      'Medical coding support (ICD-10, CPT, or HCPCS)',
      'Insurance eligibility and benefits verification',
      'Email and inbox management',
      'Content-calendar planning'
    ],
    verified_skills: [
      'Medical coding support (ICD-10, CPT, or HCPCS)',
      'Insurance eligibility and benefits verification'
    ]
  };
  const { helpers, window } = loadDirectory([profile]);
  const records = helpers.skillRecordsFor(profile);
  const featured = helpers.featuredSkills(records, 3);

  assert.deepEqual(Array.from(featured, skill => skill.areaId).sort(), ['general_admin', 'healthcare', 'social_media']);
  assert.equal(featured[0].verified, true);

  const markup = window.talentDirectory();
  assert.equal((markup.match(/directory-skill-chip directory-area--healthcare/g) || []).length, 1);
  assert.equal((markup.match(/directory-skill-chip directory-area--general-admin/g) || []).length, 1);
  assert.equal((markup.match(/directory-skill-chip directory-area--social-media/g) || []).length, 1);
  assert.match(markup, /class="directory-va-type-count"[^>]*aria-label="View all 3 VA types and their skills for Multi Area">\+1<\/button>/);
  assert.doesNotMatch(markup, />3 VA types<\/button>/);
  assert.match(directoryCss, /\.directory-va-type-count[\s\S]*?color:\s*#244f7a/);

  const twoAreas = helpers.featuredSkills(records.filter(skill => skill.areaId !== 'social_media'), 3);
  assert.deepEqual(Array.from(twoAreas, skill => skill.areaId), ['healthcare', 'general_admin', 'healthcare']);

  const customVerified = helpers.skillRecordsFor({
    verified_skills: ['Custom executive workflow'],
    self_reported_skills: profile.self_reported_skills
  });
  const customSafe = helpers.featuredSkills(customVerified, 3);
  assert.deepEqual(Array.from(customSafe, skill => skill.areaId).sort(), ['general_admin', 'healthcare', 'social_media']);
});

test('VA type and canonical Skill filters find unverified application selections', () => {
  const profiles = [
    {
      id: 'medical',
      full_name: 'Medical Applicant',
      email: 'medical@example.com',
      status: 'submitted',
      self_reported_experience_areas: ['healthcare'],
      self_reported_skills: ['Medical coding support (ICD-10, CPT, or HCPCS)'],
      verified_skills: []
    },
    {
      id: 'admin',
      full_name: 'Admin Applicant',
      email: 'admin@example.com',
      status: 'submitted',
      self_reported_experience_areas: ['general_admin'],
      self_reported_skills: ['Calendar and appointment scheduling'],
      verified_skills: []
    }
  ];

  const byType = loadDirectory(profiles);
  byType.change('talent-va-type-filter', 'healthcare');
  const typeMarkup = byType.window.talentDirectory();
  assert.equal(hasTalent(typeMarkup, 'medical'), true);
  assert.equal(hasTalent(typeMarkup, 'admin'), false);

  const bySkill = loadDirectory(profiles);
  bySkill.change('talent-skill-filter', 'medical_coding');
  const skillMarkup = bySkill.window.talentDirectory();
  assert.equal(hasTalent(skillMarkup, 'medical'), true);
  assert.equal(hasTalent(skillMarkup, 'admin'), false);
});

test('legacy canonical skills infer a VA type and unknown legacy skills remain filterable as custom', () => {
  const profiles = [{
    id: 'legacy',
    full_name: 'Legacy Applicant',
    status: 'in_review',
    legacy_application_data: { soro_ops_skills: 'Medical coding, Proprietary CRM' }
  }];
  const { helpers, window, change } = loadDirectory(profiles);
  const records = helpers.skillRecordsFor(profiles[0]);
  assert.equal(records.find(record => record.id === 'medical_coding').legacy, true);
  assert.equal(records.find(record => record.label === 'Proprietary CRM').id, '');
  assert.deepEqual(Array.from(helpers.areaIdsFor(profiles[0], records)), ['healthcare']);

  const markup = window.talentDirectory();
  assert.match(markup, /<optgroup label="Additional \/ custom skills">/);
  assert.match(markup, /value="custom:proprietary crm"/);
  change('talent-skill-filter', 'custom:proprietary crm');
  assert.equal(hasTalent(window.talentDirectory(), 'legacy'), true);
});

test('legacy comma-joined values preserve canonical skill labels that contain commas', () => {
  const profile = {
    id: 'legacy-commas',
    full_name: 'Legacy Commas',
    status: 'submitted',
    legacy_application_data: {
      skills: 'Comment, message, and community management, Medical coding support (ICD-10, CPT, or HCPCS)',
      experienceAreas: 'social_media, healthcare'
    }
  };
  const { helpers } = loadDirectory([profile]);
  const records = helpers.skillRecordsFor(profile);

  assert.equal(records.some(record => record.id === 'community_management'), true);
  assert.equal(records.some(record => record.id === 'medical_coding'), true);
  assert.deepEqual(
    Array.from(helpers.areaIdsFor(profile, records)).sort(),
    ['healthcare', 'social_media']
  );
});

test('Other and no-prior records map safely without inventing a specialty', () => {
  const { helpers } = loadDirectory([]);
  assert.deepEqual(Array.from(helpers.areaIdsFor({
    self_reported_experience_areas: ['other'],
    other_experience_specialty: 'Real estate support'
  }, [])), ['other']);
  assert.deepEqual(Array.from(helpers.areaIdsFor({
    self_reported_experience_areas: ['no_prior'],
    self_reported_skills: []
  }, [])), ['uncategorized']);
});

test('the directory shows lifecycle and client columns from the current nonterminal placement', () => {
  const { helpers, window } = loadDirectory([{
    id: 'bench',
    full_name: 'Bench Applicant',
    status: 'bench_ready',
    self_reported_experience_areas: []
  }]);
  const current = helpers.currentPlacementFromList([
    { status: 'completed', start_date: '2025-01-01', client: { company_name: 'Old Client' } },
    { status: 'onboarding', start_date: '2026-08-20', client: { company_name: 'New Client' } },
    { status: 'active', start_date: '2026-08-10', client: { company_name: 'Active Client' } }
  ]);
  assert.equal(helpers.placementClientName(current), 'Active Client');
  assert.equal(helpers.groupedStage({}, current), 'Active');
  assert.equal(helpers.groupedStage({}, { status: 'working' }), 'Active');
  assert.equal(helpers.groupedStage({ status: 'bench_ready' }, null), 'Bench');

  const markup = window.talentDirectory();
  ['Talent', 'VA type', 'Skills', 'Experience', 'Stage', 'Current client', 'Client start', 'Owner']
    .forEach(label => assert.match(markup, new RegExp(`Sort by ${label}`)));
  assert.doesNotMatch(markup, /Location &amp; time zone|Readiness/);
  assert.equal((directorySource.match(/\.from\('placements'\)/g) || []).length, 1);
  assert.match(directorySource, /client:clients\(id,company_name\)/);
  assert.match(directoryCss, /\.talent-directory-table th:nth-child\(5\)[\s\S]*?display:\s*table-cell/);
});

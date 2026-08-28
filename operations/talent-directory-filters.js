/* Talent Directory filtering, lifecycle context, and canonical application taxonomy.
   Applicant-reported skills remain visibly distinct from management-verified skills. */
(function () {
    'use strict';

    var WORK_AREAS = [
        {
            id: 'healthcare',
            label: 'Medical & healthcare support',
            filterLabel: 'Medical & Healthcare VA',
            skills: [
                ['patient_scheduling', 'Patient appointment scheduling and confirmation'],
                ['patient_intake', 'Patient intake and demographic updates'],
                ['patient_follow_up', 'Patient reminder calls and non-clinical follow-up'],
                ['insurance_verification', 'Insurance eligibility and benefits verification'],
                ['prior_authorization', 'Prior authorization and referral coordination'],
                ['medical_billing', 'Medical billing and payment-posting support'],
                ['claims_follow_up', 'Claims preparation and follow-up'],
                ['medical_coding', 'Medical coding support (ICD-10, CPT, or HCPCS)'],
                ['ehr_updates', 'EHR/EMR data entry and chart maintenance'],
                ['medical_records', 'Medical-record requests and document routing']
            ]
        },
        {
            id: 'general_admin',
            label: 'General administrative & executive support',
            filterLabel: 'General Administrative & Executive VA',
            skills: [
                ['inbox_management', 'Email and inbox management'],
                ['calendar_management', 'Calendar and appointment scheduling'],
                ['data_entry', 'Data entry and database updates'],
                ['document_formatting', 'Document preparation and formatting'],
                ['file_organization', 'File and cloud-drive organization'],
                ['online_research', 'Online research and information gathering'],
                ['meeting_coordination', 'Meeting coordination and note-taking'],
                ['crm_updates', 'CRM and contact-record maintenance'],
                ['project_tracking', 'Task and project tracking'],
                ['sop_documentation', 'SOP and process documentation']
            ]
        },
        {
            id: 'social_media',
            label: 'Social media & digital marketing',
            filterLabel: 'Social Media & Digital Marketing VA',
            skills: [
                ['content_planning', 'Content-calendar planning'],
                ['copywriting', 'Caption and social-copy writing'],
                ['graphic_design', 'Static graphic creation'],
                ['short_form_video', 'Short-form video editing'],
                ['post_scheduling', 'Post scheduling and publishing'],
                ['community_management', 'Comment, message, and community management'],
                ['inbox_moderation', 'Inbox and comment moderation'],
                ['social_analytics', 'Analytics and performance reporting'],
                ['keyword_research', 'Hashtag and keyword research'],
                ['paid_social_support', 'Paid-social campaign support']
            ]
        },
        {
            id: 'customer_support',
            label: 'Customer service & client support',
            filterLabel: 'Customer Service & Client Support VA',
            skills: [
                ['email_support', 'Email customer support'],
                ['live_chat_support', 'Live-chat customer support'],
                ['phone_support', 'Phone customer support'],
                ['helpdesk_systems', 'Ticketing-system management'],
                ['crm_case_notes', 'CRM and customer-record updates'],
                ['order_support', 'Order or appointment support'],
                ['complaint_resolution', 'Complaint handling and de-escalation'],
                ['returns_refunds', 'Returns, refunds, or cancellations'],
                ['customer_follow_up', 'Customer follow-up and retention'],
                ['knowledge_base', 'Knowledge-base or FAQ updates']
            ]
        },
        {
            id: 'ecommerce',
            label: 'E-commerce support',
            filterLabel: 'E-commerce VA',
            skills: [
                ['product_listings', 'Product listing creation and updates'],
                ['order_processing', 'Order processing'],
                ['inventory_updates', 'Inventory monitoring and updates'],
                ['customer_order_support', 'Customer order support'],
                ['marketplace_management', 'Marketplace management'],
                ['product_research', 'Product research'],
                ['supplier_coordination', 'Supplier or vendor coordination'],
                ['shipment_tracking', 'Fulfillment and shipment tracking'],
                ['returns_management', 'Return, refund, and exchange processing'],
                ['ecommerce_reporting', 'Store-performance and sales reporting']
            ]
        }
    ];
    var AREA_BY_ID = new Map(WORK_AREAS.map(function (area) { return [area.id, area]; }));
    var SKILL_BY_ID = new Map();
    var SKILL_ID_BY_LABEL = new Map();
    var placementsByApplicant = new Map();
    var supplementalKey = '';
    var supplementalLoadingKey = '';
    var placementKey = '';
    var placementLoadingKey = '';
    var lastSkillsDialogTrigger = null;

    var filterState = {
        vaType: 'all',
        skill: 'all',
        minYears: 'all',
        stage: 'all',
        sort: 'name-asc'
    };

    var STAGE_ORDER = [
        'Application', 'Review', 'On hold', 'Interview', 'Training', 'Bench',
        'Matching', 'Matched', 'Onboarding', 'Active', 'Closed', 'Inactive', 'Archived'
    ];
    var APPLICANT_STAGE = {
        draft: 'Application',
        submitted: 'Application',
        in_review: 'Review',
        needs_more_info: 'Review',
        pending_on_hold: 'On hold',
        interviewing: 'Interview',
        training: 'Training',
        bench_ready: 'Bench',
        shortlisted: 'Matching',
        client_review: 'Matching',
        placement_confirmed: 'Matched',
        onboarding: 'Onboarding',
        active: 'Active',
        withdrawn: 'Closed',
        not_selected: 'Closed',
        not_eligible: 'Closed',
        inactive: 'Inactive',
        archived: 'Archived'
    };
    var TERMINAL_PLACEMENT_STATUSES = new Set([
        'ended', 'complete', 'completed', 'cancelled', 'canceled', 'terminated',
        'closed', 'archived', 'inactive'
    ]);
    var ACTIVE_PLACEMENT_STATUSES = new Set(['active', 'live', 'working']);

    function text(value) {
        return value == null ? '' : String(value).trim();
    }

    function normalize(value) {
        var normalized = text(value);
        if (normalized.normalize) normalized = normalized.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
        return normalized
            .toLocaleLowerCase()
            .replace(/[‐‑‒–—−]/g, '-')
            .replace(/[’‘]/g, "'")
            .replace(/&/g, ' and ')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim()
            .replace(/\s+/g, ' ');
    }

    function title(value) {
        if (typeof window.titleCase === 'function') return window.titleCase(value);
        return text(value).replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
    }

    function escape(value) {
        if (typeof window.escapeHtml === 'function') return window.escapeHtml(value);
        var node = document.createElement('span');
        node.textContent = value == null ? '' : String(value);
        return node.innerHTML;
    }

    WORK_AREAS.forEach(function (area) {
        area.skills.forEach(function (skill) {
            var record = { id: skill[0], label: skill[1], areaId: area.id };
            SKILL_BY_ID.set(record.id, record);
            SKILL_ID_BY_LABEL.set(normalize(record.label), record.id);
        });
    });
    [
        ['medical coding', 'medical_coding'],
        ['medical coder', 'medical_coding'],
        ['icd 10 coding', 'medical_coding'],
        ['cpt coding', 'medical_coding'],
        ['medical billing', 'medical_billing'],
        ['patient scheduling', 'patient_scheduling'],
        ['prior authorization', 'prior_authorization']
    ].forEach(function (alias) { SKILL_ID_BY_LABEL.set(normalize(alias[0]), alias[1]); });

    function valuesFrom(source) {
        if (Array.isArray(source)) {
            return source.flatMap(function (value) {
                if (Array.isArray(value)) return valuesFrom(value);
                if (typeof value !== 'string' && typeof value !== 'number') return [];
                var item = text(value);
                return item ? [item] : [];
            });
        }
        if (typeof source !== 'string' && typeof source !== 'number') return [];
        var remaining = String(source);
        var canonicalLabels = [];
        SKILL_BY_ID.forEach(function (skill) {
            var index = remaining.toLocaleLowerCase().indexOf(skill.label.toLocaleLowerCase());
            if (index < 0) return;
            canonicalLabels.push(skill.label);
            remaining = remaining.slice(0, index) + ' ' + remaining.slice(index + skill.label.length);
        });
        return canonicalLabels.concat(remaining.split(/[;,\n|•]+/).map(text).filter(Boolean));
    }

    function legacySkillSources(profile) {
        var legacy = profile && profile.legacy_application_data;
        if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return [];
        var sources = [];
        var keywords = ['skills', 'skillset', 'skillandexperience', 'technicalskill', 'corecompetenc'];
        Object.entries(legacy).forEach(function (entry) {
            var key = normalize(entry[0]).replace(/\s/g, '');
            var value = entry[1];
            if (!keywords.some(function (keyword) { return key.includes(keyword); })) return;
            if (Array.isArray(value) || typeof value === 'string' || typeof value === 'number') sources.push(value);
        });
        return sources;
    }

    function canonicalSkillId(value) {
        var direct = text(value);
        if (SKILL_BY_ID.has(direct)) return direct;
        return SKILL_ID_BY_LABEL.get(normalize(value)) || '';
    }

    function skillRecordsFor(profile) {
        var records = new Map();
        function add(source, evidence) {
            valuesFrom(source).forEach(function (rawLabel) {
                var id = canonicalSkillId(rawLabel);
                var canonical = id ? SKILL_BY_ID.get(id) : null;
                var key = id ? 'id:' + id : 'custom:' + normalize(rawLabel);
                if (key === 'custom:') return;
                var record = records.get(key) || {
                    id: id,
                    key: key,
                    label: canonical ? canonical.label : rawLabel,
                    areaId: canonical ? canonical.areaId : '',
                    verified: false,
                    reported: false,
                    legacy: false
                };
                record[evidence] = true;
                records.set(key, record);
            });
        }

        add(profile && profile.verified_skills, 'verified');
        add(profile && profile.self_reported_skills, 'reported');
        add(profile && profile.selfReportedSkills, 'reported');
        [profile && profile.skills, profile && profile.skillsets, profile && profile.skills_and_tools, profile && profile.skills_and_tools_text]
            .forEach(function (source) { add(source, 'legacy'); });
        legacySkillSources(profile || {}).forEach(function (source) { add(source, 'legacy'); });

        return Array.from(records.values()).sort(function (left, right) {
            var evidenceOrder = Number(right.verified) - Number(left.verified) || Number(right.reported) - Number(left.reported);
            return evidenceOrder || left.label.localeCompare(right.label, undefined, { sensitivity: 'base' });
        });
    }

    function areaIdsFor(profile, skillRecords) {
        var rawAreas = valuesFrom(profile && profile.self_reported_experience_areas);
        if (!rawAreas.length) rawAreas = valuesFrom(profile && profile.experienceAreas);
        var result = [];
        rawAreas.forEach(function (areaId) {
            if (AREA_BY_ID.has(areaId) && !result.includes(areaId)) result.push(areaId);
            if (areaId === 'other' && !result.includes('other')) result.push('other');
        });
        if (profile && profile.other_experience_specialty && !result.includes('other')) result.push('other');

        if (result.length) return result;
        if (!rawAreas.length) {
            (skillRecords || skillRecordsFor(profile)).forEach(function (skill) {
                if (skill.areaId && !result.includes(skill.areaId)) result.push(skill.areaId);
            });
            if (result.length) return result;
        }
        return ['uncategorized'];
    }

    function vaTypeLabel(areaId) {
        if (AREA_BY_ID.has(areaId)) return AREA_BY_ID.get(areaId).filterLabel;
        if (areaId === 'other') return 'Other specialty';
        return 'Uncategorized / legacy';
    }

    function yearsFor(profile) {
        var value = profile.relevant_experience_years;
        if (value == null || value === '') value = profile.years_of_experience;
        if (value == null || value === '') value = profile.years_experience;
        var result = Number.parseFloat(value);
        return Number.isFinite(result) && result >= 0 ? result : null;
    }

    function yearLabel(years) {
        if (years == null) return '<span class="directory-muted">Not recorded</span>';
        return '<span class="directory-years">' + escape(years % 1 === 0 ? String(years) : years.toFixed(1)) + ' year' + (years === 1 ? '' : 's') + '</span>';
    }

    function isTerminalPlacement(placement) {
        var status = normalize(placement && placement.status).replace(/\s/g, '_');
        if (TERMINAL_PLACEMENT_STATUSES.has(status)) return true;
        var endDate = text(placement && placement.end_date);
        return Boolean(endDate && endDate < new Date().toISOString().slice(0, 10));
    }

    function placementRank(placement) {
        var status = normalize(placement && placement.status).replace(/\s/g, '_');
        if (ACTIVE_PLACEMENT_STATUSES.has(status)) return 4;
        if (status === 'onboarding') return 3;
        if (status === 'placement_confirmed' || status === 'matched') return 2;
        return 1;
    }

    function currentPlacementFromList(placements) {
        return (Array.isArray(placements) ? placements : [])
            .filter(function (placement) { return !isTerminalPlacement(placement); })
            .slice()
            .sort(function (left, right) {
                var rank = placementRank(right) - placementRank(left);
                if (rank) return rank;
                return text(right.start_date || right.created_at).localeCompare(text(left.start_date || left.created_at));
            })[0] || null;
    }

    function currentPlacementFor(profile) {
        return currentPlacementFromList(placementsByApplicant.get(profile.id));
    }

    function groupedStage(profile, placement) {
        if (placement) {
            var placementStatus = normalize(placement.status).replace(/\s/g, '_');
            if (ACTIVE_PLACEMENT_STATUSES.has(placementStatus)) return 'Active';
            if (placementStatus === 'onboarding') return 'Onboarding';
            return 'Matched';
        }
        return APPLICANT_STAGE[text(profile && profile.status).toLocaleLowerCase()] || (profile && profile.status ? title(profile.status) : 'Not recorded');
    }

    function placementClientName(placement) {
        if (!placement) return '';
        var client = placement.client || placement.clients;
        if (Array.isArray(client)) client = client[0];
        return text(client && (client.company_name || client.name));
    }

    function displayDate(value) {
        var raw = text(value);
        if (!raw) return '';
        var match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
        var date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(raw);
        return Number.isNaN(date.getTime()) ? raw : date.toLocaleDateString();
    }

    function sortColumnFor(sort) {
        return String(sort || '').replace(/-(?:asc|desc)$/, '');
    }

    function sortDirectionFor(sort) {
        return String(sort || '').endsWith('-desc') ? 'desc' : 'asc';
    }

    function sortButton(label, column) {
        var active = sortColumnFor(filterState.sort) === column;
        var direction = sortDirectionFor(filterState.sort);
        var icon = active ? (direction === 'asc' ? '↑' : '↓') : '↕';
        return '<button class="directory-sort-button ' + (active ? 'is-active' : '') + '" type="button" data-talent-sort="' + column + '" aria-label="Sort by ' + escape(label) + '" aria-pressed="' + active + '">' +
            escape(label) + '<span class="directory-sort-indicator" aria-hidden="true">' + icon + '</span></button>';
    }

    function option(value, label, selected, extra) {
        return '<option value="' + escape(value) + '"' + (value === selected ? ' selected' : '') + (extra || '') + '>' + escape(label) + '</option>';
    }

    function vaTypeOptions(selected) {
        return option('all', 'All VA types', selected) + WORK_AREAS.map(function (area) {
            return option(area.id, area.filterLabel, selected);
        }).join('') + option('other', 'Other specialty', selected) + option('uncategorized', 'Uncategorized / legacy', selected);
    }

    function stageOptions(selected) {
        return option('all', 'All stages', selected) + STAGE_ORDER.map(function (stage) { return option(stage, stage, selected); }).join('');
    }

    function skillOptions(profiles, selected) {
        var canonical = WORK_AREAS.map(function (area) {
            return '<optgroup label="' + escape(area.label) + '">' + area.skills.map(function (skill) {
                return option(skill[0], skill[1], selected, ' data-canonical-skill="true"');
            }).join('') + '</optgroup>';
        }).join('');
        var customByKey = new Map();
        profiles.forEach(function (profile) {
            skillRecordsFor(profile).forEach(function (skill) {
                if (!skill.id && !customByKey.has(normalize(skill.label))) customByKey.set(normalize(skill.label), skill.label);
            });
        });
        var librarySkills = window.soroSkillLibrary && typeof window.soroSkillLibrary.getActiveNames === 'function'
            ? window.soroSkillLibrary.getActiveNames() : [];
        librarySkills.forEach(function (label) {
            if (!canonicalSkillId(label) && !customByKey.has(normalize(label))) customByKey.set(normalize(label), label);
        });
        var custom = Array.from(customByKey.entries()).sort(function (left, right) { return left[1].localeCompare(right[1], undefined, { sensitivity: 'base' }); });
        var additional = custom.length ? '<optgroup label="Additional / custom skills">' + custom.map(function (entry) {
            return option('custom:' + entry[0], entry[1], selected);
        }).join('') + '</optgroup>' : '';
        return option('all', 'All skills', selected) + canonical + additional;
    }

    function profileMatchesSkill(records, selected) {
        if (selected === 'all') return true;
        if (selected.indexOf('custom:') === 0) return records.some(function (record) { return record.key === selected; });
        return records.some(function (record) { return record.id === selected; });
    }

    function profileSearchText(profile, skills, areas, stage, placement) {
        return [
            profile.full_name,
            profile.email,
            profile.phone,
            profile.status,
            profile.work_status,
            profile.relevant_experience_summary,
            profile.education_training_summary,
            stage,
            placementClientName(placement)
        ].concat(skills.map(function (skill) { return skill.label; }))
            .concat(areas.map(vaTypeLabel))
            .filter(Boolean).join(' ').toLocaleLowerCase();
    }

    function compareProfiles(left, right) {
        var column = sortColumnFor(filterState.sort);
        var direction = sortDirectionFor(filterState.sort) === 'desc' ? -1 : 1;
        var leftPlacement = currentPlacementFor(left);
        var rightPlacement = currentPlacementFor(right);
        var a;
        var b;

        if (column === 'experience') {
            a = yearsFor(left);
            b = yearsFor(right);
            a = a == null ? -1 : a;
            b = b == null ? -1 : b;
            return ((a - b) * direction) || text(left.full_name).localeCompare(text(right.full_name));
        }
        if (column === 'client-start') {
            a = text(leftPlacement && leftPlacement.start_date);
            b = text(rightPlacement && rightPlacement.start_date);
        } else if (column === 'va-type') {
            a = areaIdsFor(left, skillRecordsFor(left)).map(vaTypeLabel).join(', ');
            b = areaIdsFor(right, skillRecordsFor(right)).map(vaTypeLabel).join(', ');
        } else if (column === 'skills') {
            a = skillRecordsFor(left).map(function (skill) { return skill.label; }).join(', ');
            b = skillRecordsFor(right).map(function (skill) { return skill.label; }).join(', ');
        } else if (column === 'stage') {
            a = groupedStage(left, leftPlacement);
            b = groupedStage(right, rightPlacement);
        } else if (column === 'client') {
            a = placementClientName(leftPlacement);
            b = placementClientName(rightPlacement);
        } else if (column === 'owner') {
            a = left.talent_review_owner_id ? 'Assigned' : 'Unassigned';
            b = right.talent_review_owner_id ? 'Assigned' : 'Unassigned';
        } else {
            a = left.full_name;
            b = right.full_name;
        }
        return (text(a).localeCompare(text(b), undefined, { sensitivity: 'base', numeric: true }) * direction) || text(left.full_name).localeCompare(text(right.full_name));
    }

    function skillChipMarkup(skill) {
        var evidenceClass = skill.verified ? ' is-verified' : skill.reported ? ' is-reported' : ' is-legacy';
        var evidence = skill.verified ? '<small>Verified</small>' : skill.reported ? '<small>Applicant reported</small>' : '<small>Legacy</small>';
        return '<span class="directory-skill-chip ' + areaColorClass(skill.areaId) + evidenceClass + '"><span>' + escape(skill.label) + '</span>' + evidence + '</span>';
    }

    function skillCounts(skills) {
        return {
            total: skills.length,
            verified: skills.filter(function (skill) { return skill.verified; }).length,
            reported: skills.filter(function (skill) { return !skill.verified && skill.reported; }).length,
            legacy: skills.filter(function (skill) { return !skill.verified && !skill.reported; }).length
        };
    }

    function featuredSkills(skills, limit) {
        var maximum = Math.max(0, Number(limit) || 0);
        var featured = [];
        var representedAreas = new Set();
        skills.forEach(function (skill) {
            if (!AREA_BY_ID.has(skill.areaId)) return;
            var areaId = skill.areaId;
            if (featured.length >= maximum || representedAreas.has(areaId)) return;
            featured.push(skill);
            representedAreas.add(areaId);
        });
        skills.forEach(function (skill) {
            if (featured.length >= maximum || featured.includes(skill)) return;
            featured.push(skill);
        });
        return featured;
    }

    function skillMarkup(skills, profile) {
        if (!skills.length) return '<span class="directory-muted">Not recorded</span>';
        var counts = skillCounts(skills);
        var evidenceSummary = counts.verified + ' verified · ' + counts.reported + ' reported' + (counts.legacy ? ' · ' + counts.legacy + ' legacy' : '');
        var profileName = text(profile && profile.full_name) || 'this Talent';
        var summary = counts.total > 3
            ? '<span class="directory-skill-summary"><button type="button" data-directory-skills-id="' + escape(profile && profile.id) + '" aria-label="View all ' + counts.total + ' skills for ' + escape(profileName) + '">' + counts.total + ' skills</button><small>' + evidenceSummary + '</small></span>'
            : '';
        return '<span class="directory-skill-list">' + featuredSkills(skills, 3).map(skillChipMarkup).join('') + summary + '</span>';
    }

    function areaColorClass(areaId) {
        if (AREA_BY_ID.has(areaId)) return 'directory-area--' + areaId.replace(/_/g, '-');
        if (areaId === 'other') return 'directory-area--other';
        return 'directory-area--uncategorized';
    }

    function vaTypeMarkup(areas, profile) {
        var profileName = text(profile && profile.full_name) || 'this Talent';
        var summary = areas.length > 2
            ? '<button class="directory-va-type-count" type="button" data-directory-skills-id="' + escape(profile && profile.id) + '" aria-label="View all ' + areas.length + ' VA types and their skills for ' + escape(profileName) + '">+' + (areas.length - 2) + '</button>'
            : '';
        return '<span class="directory-va-type-list">' + areas.slice(0, 2).map(function (areaId) {
            return '<span class="directory-va-type ' + areaColorClass(areaId) + '">' + escape(vaTypeLabel(areaId)) + '</span>';
        }).join('') + summary + '</span>';
    }

    function stageMarkup(stage) {
        var className = normalize(stage).replace(/\s+/g, '-');
        return '<span class="directory-stage directory-stage--' + escape(className) + '">' + escape(stage) + '</span>';
    }

    function skillDialogBodyMarkup(profile) {
        var skills = skillRecordsFor(profile);
        var groups = new Map();
        skills.forEach(function (skill) {
            var areaId = AREA_BY_ID.has(skill.areaId) ? skill.areaId : 'uncategorized';
            if (!groups.has(areaId)) groups.set(areaId, []);
            groups.get(areaId).push(skill);
        });
        areaIdsFor(profile, skills).forEach(function (areaId) {
            if (!groups.has(areaId)) groups.set(areaId, []);
        });
        var groupOrder = WORK_AREAS.map(function (area) { return area.id; }).concat(['other', 'uncategorized']);
        var counts = skillCounts(skills);
        var groupsMarkup = groupOrder.filter(function (areaId) { return groups.has(areaId); }).map(function (areaId) {
            var groupSkills = groups.get(areaId);
            var skillsMarkup = groupSkills.length
                ? '<div class="directory-skill-dialog-grid">' + groupSkills.map(skillChipMarkup).join('') + '</div>'
                : '<p class="directory-skill-group-empty">No recorded skills under this VA type.</p>';
            return '<section class="directory-skill-group"><div class="directory-skill-group-heading ' + areaColorClass(areaId) + '"><h3>' + escape(vaTypeLabel(areaId)) + '</h3><span>' + groupSkills.length + '</span></div>' + skillsMarkup + '</section>';
        }).join('');
        return '<div class="directory-skill-dialog-summary"><strong>' + counts.total + ' skills</strong><span>' + counts.verified + ' verified · ' + counts.reported + ' applicant reported' + (counts.legacy ? ' · ' + counts.legacy + ' legacy' : '') + '</span></div>' + groupsMarkup;
    }

    function skillsDialogMarkup() {
        return '<dialog id="talent-skills-dialog" class="directory-skill-dialog" aria-labelledby="talent-skills-dialog-title"><div class="directory-skill-dialog-frame"><header><div><p>Matching profile</p><h2 id="talent-skills-dialog-title">Skills &amp; experience</h2><span id="talent-skills-dialog-subtitle">Grouped by VA type</span></div><button type="button" data-directory-skills-close aria-label="Close skills">×</button></header><div class="directory-skill-dialog-body" data-directory-skills-body></div></div></dialog>';
    }

    function ensureSkillsDialog() {
        var dialog = document.getElementById('talent-skills-dialog');
        if (dialog) return dialog;
        var template = document.createElement('template');
        template.innerHTML = skillsDialogMarkup();
        dialog = template.content.firstElementChild;
        document.body.appendChild(dialog);
        dialog.addEventListener('close', function () {
            if (lastSkillsDialogTrigger && lastSkillsDialogTrigger.isConnected) lastSkillsDialogTrigger.focus();
            lastSkillsDialogTrigger = null;
        });
        return dialog;
    }

    function openSkillsDialog(profileId, trigger) {
        var profile = (Array.isArray(liveApplicants) ? liveApplicants : []).find(function (candidate) { return text(candidate.id) === text(profileId); });
        var dialog = ensureSkillsDialog();
        if (!profile || !dialog) return;
        lastSkillsDialogTrigger = trigger || null;
        var title = dialog.querySelector('#talent-skills-dialog-title');
        var subtitle = dialog.querySelector('#talent-skills-dialog-subtitle');
        var body = dialog.querySelector('[data-directory-skills-body]');
        if (title) title.textContent = profile.full_name || 'Talent skills';
        if (subtitle) subtitle.textContent = 'Skills grouped by VA type';
        if (body) body.innerHTML = skillDialogBodyMarkup(profile);
        if (typeof dialog.showModal === 'function') dialog.showModal();
        else dialog.setAttribute('open', '');
        var closeButton = dialog.querySelector('[data-directory-skills-close]');
        if (closeButton) closeButton.focus();
    }

    function applicantIdsKey() {
        return (Array.isArray(liveApplicants) ? liveApplicants : []).map(function (profile) { return text(profile.id); }).filter(Boolean).sort().join(',');
    }

    async function hydrateSupplementalProfiles(ids, key) {
        if (!window.soroSupabase || !ids.length || supplementalKey === key || supplementalLoadingKey === key) return;
        supplementalLoadingKey = key;
        var response = await window.soroSupabase.from('applicants')
            .select('id,verified_skills,self_reported_experience_areas,self_reported_skills,other_experience_specialty,relevant_experience_years,relevant_experience_summary,education_training_summary,legacy_application_data')
            .in('id', ids);
        supplementalLoadingKey = '';
        if (response.error || !response.data) return;
        var supplemental = new Map(response.data.map(function (profile) { return [profile.id, profile]; }));
        liveApplicants.forEach(function (profile) {
            var extra = supplemental.get(profile.id);
            if (extra) Object.assign(profile, extra);
        });
        supplementalKey = key;
        if (current === 'vas') render();
    }

    async function hydratePlacements(ids, key) {
        if (!window.soroSupabase || !ids.length || placementKey === key || placementLoadingKey === key) return;
        placementLoadingKey = key;
        var response = await window.soroSupabase.from('placements')
            .select('id,applicant_id,status,start_date,end_date,created_at,client:clients(id,company_name)')
            .in('applicant_id', ids);
        placementLoadingKey = '';
        if (response.error || !response.data) return;
        var next = new Map();
        response.data.forEach(function (placement) {
            if (!next.has(placement.applicant_id)) next.set(placement.applicant_id, []);
            next.get(placement.applicant_id).push(placement);
        });
        placementsByApplicant = next;
        placementKey = key;
        if (current === 'vas') render();
    }

    function ensureDirectoryHydration() {
        if (!window.soroSupabase || !Array.isArray(liveApplicants) || !liveApplicants.length) return;
        var key = applicantIdsKey();
        var ids = liveApplicants.map(function (profile) { return profile.id; }).filter(Boolean);
        hydrateSupplementalProfiles(ids, key);
        hydratePlacements(ids, key);
    }

    window.talentDirectory = function () {
        var allProfiles = Array.isArray(liveApplicants) ? liveApplicants.slice() : [];
        ensureDirectoryHydration();
        var query = text(talentSearch).toLocaleLowerCase();
        var minYears = filterState.minYears === 'all' ? null : Number(filterState.minYears);

        var profiles = allProfiles.filter(function (profile) {
            var skills = skillRecordsFor(profile);
            var areas = areaIdsFor(profile, skills);
            var years = yearsFor(profile);
            var placement = currentPlacementFor(profile);
            var stage = groupedStage(profile, placement);
            var matchesSearch = !query || profileSearchText(profile, skills, areas, stage, placement).includes(query);
            var matchesType = filterState.vaType === 'all' || areas.includes(filterState.vaType);
            var matchesSkill = profileMatchesSkill(skills, filterState.skill);
            var matchesYears = minYears == null || (years != null && years >= minYears);
            var matchesStage = filterState.stage === 'all' || stage === filterState.stage;
            return matchesSearch && matchesType && matchesSkill && matchesYears && matchesStage;
        }).sort(compareProfiles);

        var rows = profiles.length ? profiles.map(function (profile) {
            var skills = skillRecordsFor(profile);
            var areas = areaIdsFor(profile, skills);
            var placement = currentPlacementFor(profile);
            var clientName = placementClientName(placement);
            var stage = groupedStage(profile, placement);
            var initialsValue = typeof window.initials === 'function' ? window.initials(profile.full_name) : text(profile.full_name).slice(0, 2);
            return '<tr class="talent-row" data-talent-id="' + escape(profile.id) + '" tabindex="0" role="link" aria-label="Open ' + escape(profile.full_name) + ' profile">' +
                '<td><div class="talent-cell"><span class="mini-avatar">' + escape(initialsValue) + '</span><span><strong>' + escape(profile.full_name) + '</strong><small>' + escape(profile.email || 'No email recorded') + '</small></span></div></td>' +
                '<td>' + vaTypeMarkup(areas, profile) + '</td>' +
                '<td>' + skillMarkup(skills, profile) + '</td>' +
                '<td>' + yearLabel(yearsFor(profile)) + '</td>' +
                '<td>' + stageMarkup(stage) + '</td>' +
                '<td>' + (clientName ? '<strong class="directory-client">' + escape(clientName) + '</strong>' : '<span class="directory-muted">Not matched</span>') + '</td>' +
                '<td>' + (placement && placement.start_date ? '<span class="directory-client-start">' + escape(displayDate(placement.start_date)) + '</span>' : '<span class="directory-muted">Not started</span>') + '</td>' +
                '<td>' + (profile.talent_review_owner_id ? 'Assigned' : 'Unassigned') + '</td></tr>';
        }).join('') : '<tr><td class="empty" colspan="8">No Talent profiles match those filters.</td></tr>';

        return '<div class="directory-toolbar panel directory-filters-grid">' +
            '<label class="directory-search directory-search--wide"><span>⌕</span><input id="talent-search" type="search" value="' + escape(talentSearch) + '" placeholder="Search name, email, VA type, skill, or client" /></label>' +
            '<label class="directory-filter-control">VA type<select id="talent-va-type-filter">' + vaTypeOptions(filterState.vaType) + '</select></label>' +
            '<label class="directory-filter-control">Skill<select id="talent-skill-filter">' + skillOptions(allProfiles, filterState.skill) + '</select></label>' +
            '<label class="directory-filter-control">Minimum experience<select id="talent-experience-filter"><option value="all">Any experience</option><option value="1"' + (filterState.minYears === '1' ? ' selected' : '') + '>1+ year</option><option value="2"' + (filterState.minYears === '2' ? ' selected' : '') + '>2+ years</option><option value="3"' + (filterState.minYears === '3' ? ' selected' : '') + '>3+ years</option><option value="5"' + (filterState.minYears === '5' ? ' selected' : '') + '>5+ years</option><option value="7"' + (filterState.minYears === '7' ? ' selected' : '') + '>7+ years</option><option value="10"' + (filterState.minYears === '10' ? ' selected' : '') + '>10+ years</option></select></label>' +
            '<label class="directory-filter-control">Stage<select id="talent-stage-filter">' + stageOptions(filterState.stage) + '</select></label>' +
            '<label class="directory-filter-control">Sort by<select id="talent-sort-filter"><option value="name-asc"' + (filterState.sort === 'name-asc' ? ' selected' : '') + '>Name A–Z</option><option value="name-desc"' + (filterState.sort === 'name-desc' ? ' selected' : '') + '>Name Z–A</option><option value="va-type-asc"' + (filterState.sort === 'va-type-asc' ? ' selected' : '') + '>VA type</option><option value="experience-desc"' + (filterState.sort === 'experience-desc' ? ' selected' : '') + '>Experience: most first</option><option value="skills-asc"' + (filterState.sort === 'skills-asc' ? ' selected' : '') + '>Skills A–Z</option><option value="stage-asc"' + (filterState.sort === 'stage-asc' ? ' selected' : '') + '>Stage</option><option value="client-start-desc"' + (filterState.sort === 'client-start-desc' ? ' selected' : '') + '>Client start: newest</option><option value="owner-asc"' + (filterState.sort === 'owner-asc' ? ' selected' : '') + '>Owner</option></select></label>' +
            '<span class="directory-count">' + profiles.length + ' of ' + allProfiles.length + ' profiles</span></div>' +
            '<div class="panel table-wrap"><table class="data-table talent-directory-table"><thead><tr>' +
            '<th>' + sortButton('Talent', 'name') + '</th><th>' + sortButton('VA type', 'va-type') + '</th><th>' + sortButton('Skills', 'skills') + '</th><th>' + sortButton('Experience', 'experience') + '</th><th>' + sortButton('Stage', 'stage') + '</th><th>' + sortButton('Current client', 'client') + '</th><th>' + sortButton('Client start', 'client-start') + '</th><th>' + sortButton('Owner', 'owner') + '</th>' +
            '</tr></thead><tbody>' + rows + '</tbody></table></div>';
    };

    function rerenderSearch() {
        var input = document.getElementById('talent-search');
        var cursor = input ? input.selectionStart : null;
        render();
        window.requestAnimationFrame(function () {
            var next = document.getElementById('talent-search');
            if (next) {
                next.focus();
                if (cursor != null) next.setSelectionRange(cursor, cursor);
            }
        });
    }

    document.addEventListener('input', function (event) {
        if (event.target && event.target.id === 'talent-search') {
            event.stopImmediatePropagation();
            talentSearch = event.target.value;
            rerenderSearch();
        }
    }, true);

    document.addEventListener('change', function (event) {
        var target = event.target;
        if (!target) return;
        if (target.id === 'talent-va-type-filter') {
            event.stopImmediatePropagation();
            filterState.vaType = target.value;
            render();
        } else if (target.id === 'talent-skill-filter') {
            event.stopImmediatePropagation();
            filterState.skill = target.value;
            render();
        } else if (target.id === 'talent-experience-filter') {
            event.stopImmediatePropagation();
            filterState.minYears = target.value;
            render();
        } else if (target.id === 'talent-stage-filter') {
            event.stopImmediatePropagation();
            filterState.stage = target.value;
            render();
        } else if (target.id === 'talent-sort-filter') {
            event.stopImmediatePropagation();
            filterState.sort = target.value;
            render();
        }
    }, true);

    document.addEventListener('click', function (event) {
        var skillButton = event.target && event.target.closest('[data-directory-skills-id]');
        var closeButton = event.target && event.target.closest('[data-directory-skills-close]');
        var dialog = event.target && event.target.closest('#talent-skills-dialog');
        if (skillButton) {
            event.preventDefault();
            event.stopImmediatePropagation();
            openSkillsDialog(skillButton.getAttribute('data-directory-skills-id'), skillButton);
            return;
        }
        if (closeButton || (dialog && event.target === dialog)) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (dialog && typeof dialog.close === 'function') dialog.close();
            else if (dialog) dialog.removeAttribute('open');
            return;
        }
        var sortButtonElement = event.target && event.target.closest('[data-talent-sort]');
        if (!sortButtonElement) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        var column = sortButtonElement.getAttribute('data-talent-sort');
        var activeColumn = sortColumnFor(filterState.sort);
        var activeDirection = sortDirectionFor(filterState.sort);
        filterState.sort = column + '-' + (activeColumn === column && activeDirection === 'asc' ? 'desc' : 'asc');
        render();
    }, true);

    document.addEventListener('keydown', function (event) {
        var skillButton = event.target && event.target.closest('[data-directory-skills-id]');
        if (!skillButton || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        openSkillsDialog(skillButton.getAttribute('data-directory-skills-id'), skillButton);
    }, true);

    window.addEventListener('soro:skill-library-updated', function () {
        if (current === 'vas') render();
    });
    window.addEventListener('soro:placements-updated', function () {
        placementKey = '';
        if (current === 'vas') render();
    });
}());
